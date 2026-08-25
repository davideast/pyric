/**
 * The `/__pyric/` reserved namespace — pyric's analog of firebase serve's
 * `/__/firebase/` namespace:
 *
 *   /__pyric/sdk/<file>.js   the bundled SDK files (import-map targets +
 *                            the injected init script + shared chunks)
 *   /__pyric/init.json       the page init payload (rules, bridge URL) —
 *                            fetched by the runtime chunk at module init
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
import { pipeFileToResponse, getHeader, isAllowedHost, isAllowedOrigin, type ServeLogger } from './server.js';
import type { InitPayload } from './init-payload.js';
import { handleActivity } from './activity-route.js';
import { createSiteTreeHandler } from './site-tree.js';
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
  /** Where hot-reload/diagnostic lines print (rules reload, denial relay).
   *  Absent ⇒ diagnostics are dropped (a caller that wires no logger opts out
   *  silently rather than falling back to raw `console`). */
  logger?: ServeLogger;
}

// ─── AI proxy (`/__pyric/ai-proxy` — pyric/ai, cdd-deltas #98.2) ───────────

/** Default upstream: local Ollama's OpenAI-compatible endpoint. */
export const AI_PROXY_DEFAULT_UPSTREAM = 'http://localhost:11434/v1';

/**
 * Request headers that must NOT be forwarded upstream: origin-sensitive
 * browser context (`origin`/`referer`/`cookie` — the upstream is a different
 * origin and must never see the page's), hop-by-hop headers, and the two the
 * proxy re-derives (`host`, `content-length`). `accept-encoding` is dropped
 * so fetch negotiates its own compression and the streamed body needs no
 * length fixups.
 */
const AI_PROXY_STRIPPED_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Handle `POST /__pyric/ai-proxy/<suffix>` — a same-origin passthrough to the
 * configured OpenAI-compatible upstream, so the browser openai engine
 * (running in the served page or the SharedWorker host) reaches a localhost
 * upstream like Ollama with ZERO CORS setup (no `OLLAMA_ORIGINS`, ever).
 *
 * Behavior:
 *   - POST only (the OpenAI chat-completions surface is POST); 405 otherwise.
 *   - the path suffix + query ride through verbatim
 *     (`/__pyric/ai-proxy/chat/completions` → `<upstream>/chat/completions`).
 *   - the request body is forwarded verbatim; headers minus the
 *     origin-sensitive/hop-by-hop set above (`authorization` DOES forward —
 *     upstreams may require a key).
 *   - the response body is STREAMED through chunk-by-chunk — SSE passthrough
 *     must never buffer, or `stream: true` completions would arrive all at
 *     once at the end.
 *   - an unreachable upstream answers 502 with a plain-text explanation.
 */
async function handleAiProxy(
  configuredUpstream: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const isPostMethod = req.method === 'POST';
  if (!isPostMethod) {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  const upstreamBase = (
    configuredUpstream ??
    process.env.PYRIC_AI_PROXY_UPSTREAM ??
    AI_PROXY_DEFAULT_UPSTREAM
  ).replace(/\/$/, '');
  const suffix = url.pathname.slice('/__pyric/ai-proxy'.length);
  const target = `${upstreamBase}${suffix}${url.search}`;

  // Buffer the REQUEST body (small JSON payloads); the RESPONSE streams.
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  // Copy into a plain-ArrayBuffer view — fetch's BodyInit typing rejects
  // Buffer's ArrayBufferLike backing.
  const body = new Uint8Array(raw.byteLength);
  body.set(raw);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const isUndefinedValue = value === undefined;
    if (isUndefinedValue) continue;
    const isStrippedHeader = AI_PROXY_STRIPPED_HEADERS.has(key.toLowerCase());
    if (isStrippedHeader) continue;
    const isArrayValue = Array.isArray(value);
    headers[key] = isArrayValue ? value.join(', ') : value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    const isErrorInstance = e instanceof Error;
    res.end(
      `pyric dev ai-proxy: upstream ${target} unreachable: ` +
        `${isErrorInstance ? e.message : String(e)}\n` +
        'Set PYRIC_AI_PROXY_UPSTREAM to an OpenAI-compatible base URL ' +
        `(default ${AI_PROXY_DEFAULT_UPSTREAM}).`,
    );
    return;
  }

  const responseHeaders: Record<string, string> = { 'cache-control': 'no-store' };
  const contentType = upstream.headers.get('content-type');
  const hasContentType = Boolean(contentType);
  if (hasContentType) responseHeaders['content-type'] = contentType!;
  res.writeHead(upstream.status, responseHeaders);
  const hasUpstreamBody = Boolean(upstream.body);
  if (!hasUpstreamBody) {
    res.end();
    return;
  }
  (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();

  // Chunk-by-chunk passthrough. A dropped client cancels the upstream read
  // so an abandoned SSE stream doesn't keep the upstream generating.
  const reader = upstream.body.getReader();
  res.on('close', () => {
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Upstream or client dropped mid-stream — nothing to salvage.
  }
  res.end();
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
    const isGetMethod = req.method === 'GET';
    if (isGetMethod) {
      const hasSection = Boolean(section);
      const value = hasSection ? state.readSection(section as StateSection) : state.load();
      const isValueMissing = value === null;
      if (isValueMissing) {
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
    const isDeleteMethod = req.method === 'DELETE';
    if (isDeleteMethod) {
      const hasWriterId = Boolean(writerId);
      if (hasWriterId) lock.release(writerId);
      res.writeHead(204).end();
      return;
    }
    const isPutMethod = req.method === 'PUT';
    if (isPutMethod) {
      // Lock heartbeat — refresh/claim WITHOUT writing state. 423 if another
      // live tab holds it.
      const isLockClaimed = lock.claim(writerId || 'anon', Date.now());
      res.writeHead(isLockClaimed ? 204 : 423).end();
      return;
    }
    const isPostMethod = req.method === 'POST';
    if (isPostMethod) {
      const isFirestoreSection = section === 'firestore';
      const isAuthSection = section === 'auth';
      const isValidSection = isFirestoreSection || isAuthSection;
      if (!isValidSection) {
        res.writeHead(400).end('section must be firestore|auth');
        return;
      }
      // Single-writer: the first page to flush claims the lock; a different
      // live page is refused (423) so it can't erase the writer's world.
      const isLockClaimed = lock.claim(writerId || 'anon', Date.now());
      if (!isLockClaimed) {
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
    const isStateFileError = e instanceof StateFileError;
    res.writeHead(isStateFileError ? 409 : 400, { 'content-type': 'text/plain' });
    const isErrorInstance = e instanceof Error;
    res.end(isErrorInstance ? e.message : String(e));
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
  const isGetMethod = req.method === 'GET';
  if (isGetMethod) {
    const body = capture.read();
    const isBodyMissing = body === null;
    if (isBodyMissing) {
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
  const isPostMethod = req.method === 'POST';
  if (!isPostMethod) {
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
    const isErrorInstance = e instanceof Error;
    res.end(isErrorInstance ? e.message : String(e));
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
      const hasLastPrinted = last !== undefined;
      const isWithinWindow = hasLastPrinted && now - last! < windowMs;
      if (isWithinWindow) return false;
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
  const isMessageString = typeof payload.message === 'string';
  const message = isMessageString ? (payload.message as string) : 'permission denied';
  const lines = [`  ⚠ [pyric] denied: ${message}`];
  const ctx = payload.denialContext;
  const request = ctx?.request;
  const hasMethodAndPath = Boolean(request?.method) && Boolean(request?.path);
  if (hasMethodAndPath) {
    lines.push(`      ${request!.method} ${request!.path}`);
  }
  const uid = ctx?.auth?.uid;
  lines.push(`      auth: ${uid ?? 'anonymous'}`);
  const isRemediationString = typeof payload.remediation === 'string';
  const remediation = isRemediationString ? (payload.remediation as string) : ctx?.remediation;
  const hasRemediation = Boolean(remediation);
  if (hasRemediation) lines.push(`      ${remediation}`);
  return lines.join('\n');
}

/** Handle `POST /__pyric/denials`. Always 204s (best-effort diagnostics —
 *  a malformed body or a caller with no logger wired must never fail the
 *  page that reported the denial). */
async function handleDenials(
  throttle: DenialThrottle,
  logger: ServeLogger | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const isPostMethod = req.method === 'POST';
  if (!isPostMethod) {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  try {
    const payload = (await collectBody(req)) as DenialRelayPayload;
    const isMessageString = typeof payload.message === 'string';
    const message = isMessageString ? (payload.message as string) : 'permission denied';
    const path = payload.denialContext?.request?.path ?? '';
    const key = `${path}\0${message}`;
    const hasLogger = Boolean(logger);
    const shouldPrint = hasLogger && throttle.shouldPrint(key, Date.now());
    if (shouldPrint) {
      logger!.note(formatDenialBlock(payload));
    }
  } catch {
    /* malformed body — drop it; this is a diagnostics side channel */
  }
  res.writeHead(204).end();
}

export function createPyricNamespace(opts: NamespaceOptions) {
  const stateWriterLock = createWriterLock();
  const studioWriterLock = opts.studio?.writerLock ?? createWriterLock();
  const sessionToken = opts.sessionToken ?? randomBytes(24).toString('base64url');
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
    const hasStudioRoutes = Boolean(studioRoutes);
    const isWorkspacePath = url.pathname.startsWith('/__pyric/workspace');
    const isProjectsPath = url.pathname.startsWith('/__pyric/projects');
    const isStudioPath = isWorkspacePath || isProjectsPath;
    const shouldHandleStudio = hasStudioRoutes && isStudioPath;
    if (shouldHandleStudio) {
      return studioRoutes!(req, res, url);
    }
    const hasStateStore = Boolean(opts.state);
    const isStatePath = url.pathname === '/__pyric/state';
    const isStateRoute = hasStateStore && isStatePath;
    if (isStateRoute) {
      return handleState(opts.state!, stateWriterLock, req, res, url).then(() => true);
    }
    const hasCapture = Boolean(opts.capture);
    const isCapturePath = url.pathname === '/__pyric/capture';
    const isCaptureRoute = hasCapture && isCapturePath;
    if (isCaptureRoute) {
      return handleCapture(opts.capture!, req, res).then(() => true);
    }
    const hasActivity = Boolean(opts.activity);
    const isActivityPath = url.pathname === '/__pyric/activity';
    const isActivityRoute = hasActivity && isActivityPath;
    if (isActivityRoute) {
      return handleActivity(opts.activity!, req, res, activityToken!).then(() => true);
    }
    const hasEvents = Boolean(opts.events);
    const isEventsPath = url.pathname === '/__pyric/events';
    const isEventsRoute = hasEvents && isEventsPath;
    if (isEventsRoute) {
      const hostHeader = getHeader(req, 'host');
      const originHeader = getHeader(req, 'origin');
      const isHostAllowed = isAllowedHost(hostHeader, opts.boundHost ?? 'localhost', opts.allowedHosts);
      if (!isHostAllowed) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
        return true;
      }
      const hasOriginHeader = Boolean(originHeader);
      const isOriginAllowed = isAllowedOrigin(originHeader, opts.boundHost ?? 'localhost', opts.allowedHosts);
      const isOriginInvalid = hasOriginHeader && !isOriginAllowed;
      if (isOriginInvalid) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
        return true;
      }
      const reqToken = getHeader(req, 'x-pyric-session-token') ?? url.searchParams.get('token');
      const hasSessionTokenConfig = Boolean(sessionToken);
      const hasReqToken = Boolean(reqToken);
      const isTokenMismatch = reqToken !== sessionToken;
      const isUnauthorizedToken = hasSessionTokenConfig && hasReqToken && isTokenMismatch;
      if (isUnauthorizedToken) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      opts.events!.handle(req, res);
      return true;
    }
    const isAiProxyExact = url.pathname === '/__pyric/ai-proxy';
    const isAiProxyPrefix = url.pathname.startsWith('/__pyric/ai-proxy/');
    const isAiProxyRoute = isAiProxyExact || isAiProxyPrefix;
    if (isAiProxyRoute) {
      return handleAiProxy(opts.aiProxyUpstream, req, res, url).then(() => true);
    }
    const isDenialsPath = url.pathname === '/__pyric/denials';
    if (isDenialsPath) {
      return handleDenials(denialThrottle, opts.logger, req, res).then(() => true);
    }
    const isInitJsonPath = url.pathname === '/__pyric/init.json';
    if (isInitJsonPath) {
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
    const isSdkPath = url.pathname.startsWith('/__pyric/sdk/');
    if (isSdkPath) {
      // basename() flattens any traversal attempt — the sdk dir is flat.
      const file = join(opts.sdkDir, basename(url.pathname));
      const isFileMissing = !existsSync(file);
      if (isFileMissing) {
        res.writeHead(404).end('not found');
        return true;
      }
      const isSourceMap = file.endsWith('.map');
      const type = isSourceMap ? 'application/json' : 'text/javascript; charset=utf-8';
      // Immutable-friendly: bundle filenames are content-hashed chunks or
      // cache-keyed outputs; still no-store in dev for simplicity.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    const isSiteTreeHandled = Boolean(siteTree?.(req, res, url));
    if (isSiteTreeHandled) return true;
    return false; // unknown /__pyric/* → caller 404s
  };
}
