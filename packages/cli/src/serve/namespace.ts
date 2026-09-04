/**
 * The `/__pyric/` reserved namespace — pyric's analog of firebase serve's
 * `/__/firebase/` namespace:
 *
 *   /__pyric/sdk/<file>.js   the bundled SDK files (import-map targets +
 *                            the injected init script + shared chunks)
 *   /__pyric/init.json       the page init payload (rules, bridge URL) —
 *                            fetched by the runtime chunk at module init
 *   /__pyric/beacon          the handshake beacon a pyric-launched child
 *                            POSTs once its interception is installed
 *
 * Bridge routes (`/__pyric/mcp`, `/__pyric/sandbox`) mount here in P2.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { collectBody } from '../bridge/server/peer.js';
import { StateFileError, type StateSection, type StateStore } from './state-store.js';
import { createWriterLock, type WriterLock } from './writer-lock.js';
import { createStudioRoutes, type StudioRouteOptions } from './studio/index.js';
import { pipeFileToResponse, getHeader, isAllowedHost, isAllowedOrigin, isAllowedSessionToken, type ServeLogger } from './server.js';
import type { InitPayload } from './init-payload.js';
import { handleActivity } from './activity-route.js';
import { handleAiProxy, AI_PROXY_ROUTE } from './ai-proxy.js';
import { aiTerminalBlockFor, type AiDiagnosticPayload } from './ai-terminal-blocks.js';
import { createSiteTreeHandler } from './site-tree.js';
import { BEACON_PATH, type BeaconReport } from '../register/beacon.js';
import { handleBeacon } from './beacon-route.js';
export type { InitPayload } from './init-payload.js';

/**
 * Server-sent-events hub for `/__pyric/events` — the hot-reload channel
 * (P3). The runtime opens an EventSource; the rules watcher broadcasts
 * `rules-changed` and connected pages re-deploy without a refresh.
 */
export interface ServeEventHub {
  /** Mounted inside the namespace handler. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  broadcast(event: string, data: unknown): void;
  clientCount(): number;
  /** End all open streams. Idempotent; used by host-neutral session cleanup. */
  close(): void;
}

export function createEventHub(): ServeEventHub {
  const clients = new Set<ServerResponse>();
  let closed = false;
  return {
    handle(req, res) {
      if (closed) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('sandbox session closed');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      // A dying SSE socket must never surface an unhandled 'error' event
      // (which would kill the whole serve process) — drop the client instead.
      res.on('error', () => clients.delete(res));
    },
    broadcast(event, data) {
      if (closed) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res); // half-closed socket in the close race window
        }
      }
    },
    clientCount: () => clients.size,
    close() {
      if (closed) return;
      closed = true;
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

export interface NamespaceOptions {
  /** The bundle output dir (`BundleResult.outDir`). */
  sdkDir: string;
  /** Producer for `/__pyric/init.json` — a function so hot-reload serves
   *  the latest rules without server restart. */
  initPayload: () => InitPayload;
  /** Hot-reload channel; serves `/__pyric/events` when present. */
  events?: ServeEventHub;
  /** Default-on Firebase Activity Guard sink. The served worker posts bounded,
   *  deduplicated incidents here so the host can surface them in its terminal. */
  activity?: (incident: ActivityIncident) => void;
  /** `--persist`: mounts GET/POST /__pyric/state (the state channel). */
  state?: StateStore;
  /** `--capture`: mounts GET/POST /__pyric/capture. POST — the page/worker
   *  pushes its session fixture here; the handler writes it verbatim to
   *  `.pyric/last-session.json` for `pyric verify` to replay. GET — returns the
   *  current fixture JSON (200) or 404 when nothing is captured yet, so the
   *  served worker can re-hydrate its event history on boot after a death. */
  capture?: { write(json: string): void; read(): string | null };
  /** Unified Astro documentation + Studio tree, built for `/__pyric/ui/`. */
  siteUiDir?: string;
  /** Served SharedWorker epoch stamped only into Studio entry documents. */
  workerVersion?: string;
  /** `--ui` (Pyric Studio): mounts `/__pyric/workspace` + `/__pyric/projects`
   *  (disk-backed `WorkspaceStore`/`ProjectStore`, plus the SSE watch stream)
   *  that `@pyric/studio`'s `local` mode talks to. */
  studio?: StudioRouteOptions;
  /** Per-boot session capability token required on workspace and project endpoints. */
  sessionToken?: string;
  /** Bound host for DNS rebinding guard. */
  boundHost?: string;
  /** Extra allowed hostnames. */
  allowedHosts?: string[];
  /** The OpenAI-compatible upstream `/__pyric/ai-proxy` forwards to
   *  (pyric/ai — cdd-deltas #98.2). Falls back to the
   *  `PYRIC_AI_PROXY_UPSTREAM` env var, then `http://localhost:11434/v1`
   *  (local Ollama). Always mounted — the route only touches the network
   *  when a request arrives. */
  aiProxyUpstream?: string;
  /** Receives one handshake beacon per pyric-launched child (`POST
   *  /__pyric/beacon`, sent by `@pyric/cli/register` once its hooks and
   *  net-guard are installed). Absent means the route still 204s; the child
   *  must never be able to fail on its own proof-of-life. */
  beacon?: (report: BeaconReport) => void;
  /** The per-launch secret a beacon must present in `x-pyric-beacon-token`,
   *  which the launcher puts in the child's `PYRIC_BEACON_TOKEN`. Absent means
   *  one is generated that nobody holds, so the route accepts nothing. */
  beaconToken?: string;
  /** Where hot-reload/diagnostic lines print (rules reload, denial relay,
   *  AI broker diagnostics, ai-proxy upstream failures). Absent ⇒ diagnostics
   *  are dropped (a caller that wires no logger opts out silently rather than
   *  falling back to raw `console`). */
  logger?: ServeLogger;
}

/** The page's persistence backend speaks this route:
 *  GET    /__pyric/state                    → whole envelope (404 when absent)
 *  GET    /__pyric/state?section=firestore  → that section (404 when null)
 *  POST   /__pyric/state?section=...        → write the section (204; 423 if
 *                                             another tab holds the writer lock)
 *  DELETE /__pyric/state                    → release the writer lock (beacon)
 *  Writes carry `x-pyric-writer: <id>`; the first writer wins, others get 423
 *  and drop to read-only (pre-mortem #3). The firestore body is the sandbox
 *  persistence controller's own blob — stored verbatim, never interpreted. */
async function handleState(
  state: StateStore,
  lock: WriterLock,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const section = url.searchParams.get('section');
  const writerId = (req.headers['x-pyric-writer'] as string | undefined) ?? '';
  try {
    if (req.method === 'GET') {
      const value = section ? state.readSection(section as StateSection) : state.load();
      if (value === null) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('null');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Lets `pyric snapshot` detect it scanned into a NEIGHBOR project's
        // serve (pre-mortem #4) and warn instead of promoting the wrong DB.
        'x-pyric-project-dir': state.projectDir,
      });
      res.end(JSON.stringify(value));
      return;
    }
    if (req.method === 'DELETE') {
      if (writerId) lock.release(writerId);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'PUT') {
      // Lock heartbeat — refresh/claim WITHOUT writing state. 423 if another
      // live tab holds it.
      res.writeHead(lock.claim(writerId || 'anon', Date.now()) ? 204 : 423).end();
      return;
    }
    if (req.method === 'POST') {
      if (section !== 'firestore' && section !== 'auth') {
        res.writeHead(400).end('section must be firestore|auth');
        return;
      }
      // Single-writer: the first page to flush claims the lock; a different
      // live page is refused (423) so it can't erase the writer's world.
      if (!lock.claim(writerId || 'anon', Date.now())) {
        res.writeHead(423, { 'content-type': 'text/plain' }).end(
          `another tab holds the persist writer lock (held by ${lock.holder()})`,
        );
        return;
      }
      const body = await collectBody(req);
      state.writeSection(section, body);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405, { allow: 'GET, POST, DELETE' }).end('method not allowed');
  } catch (e) {
    // StateFileError (corrupt/version) or bad body — surface, don't clobber.
    res.writeHead(e instanceof StateFileError ? 409 : 400, { 'content-type': 'text/plain' });
    res.end(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Handle POST /__pyric/capture — the page pushes its full session fixture
 * (JSON-serialized history + snapshot + rules) whenever the sandbox changes.
 * The server writes it verbatim to `.pyric/last-session.json` so
 * `pyric verify` can pick it up without any extra arguments.
 *
 * GET returns the current fixture JSON verbatim (200), or 404 when nothing
 * has been captured yet. The served SharedWorker fetches this on boot to
 * re-hydrate its in-memory event history after a worker death (Traffic /
 * activity / metrics survive the refresh even though the worker restarted).
 * Cheap + read-only.
 *
 * POST fails fast rather than silently swallowing write errors so the
 * developer knows the capture is broken.
 *
 * We collect the RAW request body as a string rather than using
 * `collectBody` (which parses JSON). The capture must be stored verbatim
 * — re-serializing a parsed object would round-trip through JS values and
 * could alter key order or lose whitespace, making the file differ from
 * what the page intended to write.
 */
async function handleCapture(
  capture: { write(json: string): void; read(): string | null },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const body = capture.read();
    if (body === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('null');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed');
    return;
  }
  try {
    const body = await new Promise<string>((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { raw += chunk; });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
    capture.write(body);
    res.writeHead(204).end();
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(e instanceof Error ? e.message : String(e));
  }
}

// ─── Denial relay (`POST /__pyric/denials` — headless dev visibility) ─────
//
// The worker client (`serve/worker/client/core.ts`) fire-and-forget POSTs
// here whenever it reconstructs an error carrying `denialContext` (a rules
// denial) — from a one-shot rejection or an unobserved listener error alike.
// An agent driving `pyric dev` headlessly has no browser console to watch;
// this is that visibility, printed to the terminal instead.
//
// The route carries the AI broker's diagnostics on the same channel, relayed
// by `serve/ai-diagnostics-relay.ts` off the sandbox event stream:
// `request_rejected` (a malformed request) and `response_blocked` (a safety
// or recitation filter withheld the answer). Same category ("the sandbox
// refused your operation"), same terminal treatment, same throttle, so they
// ride here rather than opening parallel diagnostics channels.
// `model_substituted` (an engine answered as a model the code never named)
// rides along too: not a refusal, but the same "the sandbox quietly did
// something else" category. The payload's `kind` discriminates the four, and
// `ai-terminal-blocks.ts` holds one record per AI kind so this route
// dispatches through a table instead of a cascade.
//
// A denied listener re-fires on every auth/rules change, so printing is
// throttled per (path, message) pair — at most one line per window, and
// silent (no output at all) on suppression rather than a "suppressed N more"
// line, to keep this a diagnostics side channel, not its own log noise.

const DENIAL_THROTTLE_MS = 5_000;

/** Loosely-typed mirror of the client's relay payload — JSON from the served
 *  page, read defensively since nothing here enforces the wire shape. */
interface DenialRelayPayload {
  kind?: unknown;
  code?: unknown;
  message?: unknown;
  /** Sibling of `denialContext` on the sandbox error — query-proof denials
   *  attach the suggested `where()` fix there; the client forwards it. */
  remediation?: unknown;
  denialContext?: {
    auth?: { uid?: string } | null;
    request?: { method?: string; path?: string };
    /** Fallback position, in case a denial path nests it in the context. */
    remediation?: string;
  } | null;
}

/** Per-dev-server-instance throttle: at most one printed line per (path,
 *  message) pair within {@link DENIAL_THROTTLE_MS}. Exported for unit tests. */
export function createDenialThrottle(windowMs: number = DENIAL_THROTTLE_MS): {
  shouldPrint(key: string, now: number): boolean;
} {
  const lastPrinted = new Map<string, number>();
  return {
    shouldPrint(key, now) {
      const last = lastPrinted.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      lastPrinted.set(key, now);
      return true;
    },
  };
}
type DenialThrottle = ReturnType<typeof createDenialThrottle>;

/** Format a relayed denial into the compact terminal block: the message,
 *  then (when present) the request method/path, the auth uid, and any
 *  remediation guidance. A few lines, never a JSON dump. */
export function formatDenialBlock(payload: DenialRelayPayload): string {
  const message = typeof payload.message === 'string' ? payload.message : 'permission denied';
  const lines = [`  ⚠ [pyric] denied: ${message}`];
  const ctx = payload.denialContext;
  const request = ctx?.request;
  if (request?.method && request?.path) {
    lines.push(`      ${request.method} ${request.path}`);
  }
  const uid = ctx?.auth?.uid;
  lines.push(`      auth: ${uid ?? 'anonymous'}`);
  const remediation = typeof payload.remediation === 'string' ? payload.remediation : ctx?.remediation;
  if (remediation) lines.push(`      ${remediation}`);
  return lines.join('\n');
}

/**
 * The throttle key separator: a NUL byte, written as an escape so the file
 * stays greppable. It cannot occur in a Firestore path, a model id, or a
 * rejection reason, so no (target, reason) pair can be spelled two ways.
 */
const THROTTLE_KEY_SEPARATOR = '\x00';

/** Handle `POST /__pyric/denials`: a rules denial, or (discriminated by
 *  `kind`) an AI broker rejection, blocked response, or model substitution
 *  relayed off the sandbox event stream. All four share the throttle map: an
 *  agent retry loop re-sends the SAME malformed (or filter-tripping) AI
 *  request exactly the way a denied listener re-fires, so one line per
 *  (target, reason) per window is the right volume for every one of them.
 *  Always 204s (best-effort diagnostics: a malformed body or a caller with no
 *  logger wired must never fail the page that reported the refusal). */
async function handleDenials(
  throttle: DenialThrottle,
  logger: ServeLogger | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  try {
    const payload = (await collectBody(req)) as DenialRelayPayload & AiDiagnosticPayload;
    const aiBlock = aiTerminalBlockFor(payload.kind);
    let target: string;
    let reason: string;
    let render: () => string;
    if (aiBlock === null) {
      target = payload.denialContext?.request?.path ?? '';
      reason = typeof payload.message === 'string' ? payload.message : 'permission denied';
      render = () => formatDenialBlock(payload);
    } else {
      target = aiBlock.throttleTarget(payload);
      reason = aiBlock.throttleReason(payload);
      render = () => aiBlock.format(payload);
    }
    const key = `${target}${THROTTLE_KEY_SEPARATOR}${reason}`;
    if (logger && throttle.shouldPrint(key, Date.now())) {
      logger.note(render());
    }
  } catch {
    /* malformed body: drop it; this is a diagnostics side channel */
  }
  res.writeHead(204).end();
}

function guardLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  boundHost: string,
  allowedHosts?: string[],
): boolean {
  const hostHeader = getHeader(req, 'host');
  const originHeader = getHeader(req, 'origin');
  if (!isAllowedHost(hostHeader, boundHost, allowedHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
    return false;
  }
  if (originHeader && !isAllowedOrigin(originHeader, boundHost, allowedHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
    return false;
  }
  return true;
}

export function createPyricNamespace(opts: NamespaceOptions) {
  const stateWriterLock = createWriterLock();
  const studioWriterLock = opts.studio?.writerLock ?? createWriterLock();
  const sessionToken = opts.sessionToken ?? randomBytes(24).toString('base64url');
  // Fail closed: with no launcher-supplied secret the generated one is held by
  // nobody, so `/__pyric/beacon` accepts nothing rather than everything.
  const beaconToken = opts.beaconToken ?? randomBytes(24).toString('base64url');
  let studioRoutes: ((req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>) | null = null;
  if (opts.studio) {
    const studioOptions: StudioRouteOptions = {
      ...opts.studio,
      sessionToken,
      writerLock: studioWriterLock,
      boundHost: opts.boundHost,
      allowedHosts: opts.allowedHosts,
    };
    studioRoutes = createStudioRoutes(studioOptions);
  }
  const siteTree = opts.siteUiDir
    ? createSiteTreeHandler(opts.siteUiDir, opts.workerVersion)
    : null;
  const denialThrottle = createDenialThrottle();
  // Issued once per server boot. The outer static/Vite host guard protects
  // init.json before this capability is disclosed to the served runtime.
  const activityToken = opts.activity ? randomBytes(24).toString('base64url') : undefined;
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean> => {
    if (
      studioRoutes &&
      (url.pathname.startsWith('/__pyric/workspace') ||
        url.pathname.startsWith('/__pyric/projects'))
    ) {
      if (!guardLoopback(req, res, opts.boundHost ?? 'localhost', opts.allowedHosts)) {
        return true;
      }
      return studioRoutes(req, res, url);
    }
    if (opts.state && url.pathname === '/__pyric/state') {
      if (!guardLoopback(req, res, opts.boundHost ?? 'localhost', opts.allowedHosts)) {
        return true;
      }
      if (!isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return handleState(opts.state!, stateWriterLock, req, res, url).then(() => true);
    }
    if (opts.capture && url.pathname === '/__pyric/capture') {
      if (!guardLoopback(req, res, opts.boundHost ?? 'localhost', opts.allowedHosts)) {
        return true;
      }
      if (!isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return handleCapture(opts.capture, req, res).then(() => true);
    }
    if (opts.activity && url.pathname === '/__pyric/activity') {
      return handleActivity(opts.activity, req, res, activityToken!).then(() => true);
    }
    if (opts.events && url.pathname === '/__pyric/events') {
      if (!guardLoopback(req, res, opts.boundHost ?? 'localhost', opts.allowedHosts)) {
        return true;
      }
      opts.events.handle(req, res);
      return true;
    }
    if (url.pathname === AI_PROXY_ROUTE || url.pathname.startsWith(`${AI_PROXY_ROUTE}/`)) {
      return handleAiProxy(opts.aiProxyUpstream, denialThrottle, req, res, url, opts.logger).then(
        () => true,
      );
    }
    if (url.pathname === BEACON_PATH) {
      return handleBeacon({ token: beaconToken, onBeacon: opts.beacon }, req, res).then(() => true);
    }
    if (url.pathname === '/__pyric/denials') {
      return handleDenials(denialThrottle, opts.logger, req, res).then(() => true);
    }
    if (url.pathname === '/__pyric/init.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          ...opts.initPayload(),
          sessionToken,
          ...(activityToken ? { activityToken } : {}),
        }),
      );
      return true;
    }
    if (url.pathname.startsWith('/__pyric/sdk/')) {
      // basename() flattens any traversal attempt — the sdk dir is flat.
      const file = join(opts.sdkDir, basename(url.pathname));
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return true;
      }
      const type = file.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8';
      // Immutable-friendly: bundle filenames are content-hashed chunks or
      // cache-keyed outputs; still no-store in dev for simplicity.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    if (siteTree?.(req, res, url)) return true;
    return false; // unknown /__pyric/* → caller 404s
  };
}
