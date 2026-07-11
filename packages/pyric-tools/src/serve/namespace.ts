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
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectBody } from '../bridge/server/peer.js';
import { StateFileError, type StateSection, type StateStore } from './state-store.js';
import { createWriterLock, type WriterLock } from './writer-lock.js';
import { createStudioRoutes, type StudioRouteOptions } from './studio/index.js';
import { contentTypeFor, pipeFileToResponse, resolveStaticFile } from './server.js';
import { SANDBOX_BUILD_MARKER } from './sandbox-marker.js';

/** Mirrors the runtime entry's `InitPayload` — keep in lockstep with
 *  `entries/runtime.ts`. */
export interface InitPayload {
  rules: string | null;
  rulesHash: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  databaseRulesHash?: string | null;
  databaseUrl?: string | null;
  /** Storage rules source (plain storage-rules language), or null when the
   *  project has no storage.rules configured/present. Deployed ONCE at
   *  sandbox boot — `pyric/storage` only honors rules on the FIRST
   *  storage call per `Sandbox` (a documented invariant, not an
   *  oversight: a later, differing rules source would otherwise be a
   *  silent rules wipe). Unlike firestore/database rules, storage rules
   *  do NOT hot-reload — editing storage.rules while `pyric dev` is
   *  running requires a restart to take effect. */
  storageRules?: string | null;
  storageRulesHash?: string | null;
  bridgeUrl: string | null;
  /** `--seed` documents (path → fields), applied admin-style at page init.
   *  Null in persist mode once a state file exists — the lived state wins. */
  seed: Record<string, Record<string, unknown>> | null;
  /** `--persist`: the page enables sandbox persistence over /__pyric/state. */
  persist?: boolean;
  /** Ephemeral fixture restore (`--seed <state-file>` without --persist):
   *  the controller blob, restored in-page via a read-only backend so
   *  wrapper types re-hydrate. Null otherwise. */
  seedState?: unknown | null;
  /** Persisted auth users (sandbox.exportUsers shape), seeded at page init
   *  before any session restore. Null when none / persist off. */
  authUsers?: ReadonlyArray<Record<string, unknown>> | null;
  /** `--capture`: the page pushes its session fixture to /__pyric/capture
   *  so `pyric verify` can replay it. Default-on; suppressed by --no-capture. */
  capture?: boolean;
  /** Messaging climb gate (CDD isolation decision): the SharedWorker host
   *  enables its flag-gated `messaging.*` ops only when this is true. The
   *  serve producers emit it from `PYRIC_CLIMB=1` — messaging is in
   *  `pyric dev` ONLY when explicitly enabled; absent/false ⇒ the ops
   *  answer `messaging/disabled`. Consumed by the WORKER (serve-init), not
   *  the page runtime. */
  messaging?: boolean;
}

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
}

export function createEventHub(): ServeEventHub {
  const clients = new Set<ServerResponse>();
  return {
    handle(req, res) {
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
  /** `--persist`: mounts GET/POST /__pyric/state (the state channel). */
  state?: StateStore;
  /** `--capture`: mounts GET/POST /__pyric/capture. POST — the page/worker
   *  pushes its session fixture here; the handler writes it verbatim to
   *  `.pyric/last-session.json` for `pyric verify` to replay. GET — returns the
   *  current fixture JSON (200) or 404 when nothing is captured yet, so the
   *  served worker can re-hydrate its event history on boot after a death. */
  capture?: { write(json: string): void; read(): string | null };
  /** `--ui` (Pyric Studio): mounts `/__pyric/workspace` + `/__pyric/projects`
   *  (disk-backed `WorkspaceStore`/`ProjectStore`, plus the SSE watch stream)
   *  that `@pyric/studio`'s `local` mode talks to. */
  studio?: StudioRouteOptions;
  /** `--ui` (Pyric Studio): the dir of the built Studio app, served under
   *  `/__pyric/ui/`. Resolved by file path in the CLI (pyric-tools never
   *  imports `@pyric/studio`). Absent when `--ui` is off or the build is
   *  missing. */
  studioUiDir?: string;
  /** `--ui` (Pyric Studio): the built playground app, mounted under
   *  `/__pyric/playground/` for Studio's Playground tab. */
  playgroundUiDir?: string;
  /** `--ui` (Pyric Studio): the built docs site (site-docs), served so the
   *  Studio Docs tab has local docs without the hosted site. Built with base
   *  `/__pyric/ui/`, so its output straddles two subtrees under the mount:
   *  the pages/twins/index.json live under `/__pyric/ui/docs/`, but the shared
   *  assets live at `/__pyric/ui/_astro/` (Astro's asset dir, at the base
   *  root — NOT under `docs/`). Both are served from this one dir. */
  docsUiDir?: string;
  /** The OpenAI-compatible upstream `/__pyric/ai-proxy` forwards to
   *  (pyric/ai — cdd-deltas #98.2). Falls back to the
   *  `PYRIC_AI_PROXY_UPSTREAM` env var, then `http://localhost:11434/v1`
   *  (local Ollama). Always mounted — the route only touches the network
   *  when a request arrives. */
  aiProxyUpstream?: string;
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
  if (req.method !== 'POST') {
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
    if (value === undefined) continue;
    if (AI_PROXY_STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(
      `pyric dev ai-proxy: upstream ${target} unreachable: ` +
        `${e instanceof Error ? e.message : String(e)}\n` +
        'Set PYRIC_AI_PROXY_UPSTREAM to an OpenAI-compatible base URL ' +
        `(default ${AI_PROXY_DEFAULT_UPSTREAM}).`,
    );
    return;
  }

  const responseHeaders: Record<string, string> = { 'cache-control': 'no-store' };
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders['content-type'] = contentType;
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
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

export function createPyricNamespace(opts: NamespaceOptions) {
  const writerLock = createWriterLock();
  const studioRoutes = opts.studio ? createStudioRoutes(opts.studio) : null;
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean> => {
    if (
      studioRoutes &&
      (url.pathname.startsWith('/__pyric/workspace') ||
        url.pathname.startsWith('/__pyric/projects'))
    ) {
      return studioRoutes(req, res, url);
    }
    if (opts.state && url.pathname === '/__pyric/state') {
      return handleState(opts.state!, writerLock, req, res, url).then(() => true);
    }
    if (opts.capture && url.pathname === '/__pyric/capture') {
      return handleCapture(opts.capture, req, res).then(() => true);
    }
    if (opts.events && url.pathname === '/__pyric/events') {
      opts.events.handle(req, res);
      return true;
    }
    if (url.pathname === '/__pyric/ai-proxy' || url.pathname.startsWith('/__pyric/ai-proxy/')) {
      return handleAiProxy(opts.aiProxyUpstream, req, res, url).then(() => true);
    }
    if (url.pathname === '/__pyric/init.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(opts.initPayload()));
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
    if (opts.playgroundUiDir && (url.pathname === '/__pyric/playground' || url.pathname.startsWith('/__pyric/playground/'))) {
      if (url.pathname === '/__pyric/playground') {
        res.writeHead(301, { location: '/__pyric/playground/' }).end();
        return true;
      }
      const rel = url.pathname.slice('/__pyric/playground'.length) || '/';
      let file = resolveStaticFile(opts.playgroundUiDir, rel);
      if (!file && !extname(rel)) file = resolveStaticFile(opts.playgroundUiDir, '/index.html');
      if (!file) {
        res.writeHead(404).end('not found');
        return true;
      }
      res.writeHead(200, { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    // Embedded docs site (site-docs). MUST run BEFORE the general
    // `/__pyric/ui/` studio handler below: that handler's SPA fallback answers
    // every miss with Studio's index.html, which would swallow docs pages and
    // (worse) return HTML for a missing docs asset. Built with base
    // `/__pyric/ui/`, the docs output lives in TWO subtrees under the mount —
    // pages/twins/index.json under `/__pyric/ui/docs/`, and shared assets at
    // `/__pyric/ui/_astro/` (Astro's asset dir sits at the base root, not under
    // `docs/`). We claim both; `_astro` is Astro-specific and never collides
    // with Studio (Vite emits `/__pyric/ui/assets/`). No SPA fallback here — a
    // genuinely missing docs page 404s (a broken doc link must fail loudly, not
    // masquerade as another page). Directory-format pages (`<slug>/index.html`)
    // and `bunx serve`-style extensionless→trailing-slash redirects are handled
    // by resolveStaticFile + the directory redirect below.
    if (
      opts.docsUiDir &&
      (url.pathname === '/__pyric/ui/docs' ||
        url.pathname.startsWith('/__pyric/ui/docs/') ||
        url.pathname.startsWith('/__pyric/ui/_astro/'))
    ) {
      const rel = url.pathname.slice('/__pyric/ui'.length) || '/';
      // `bunx serve` parity: an extensionless path that names a real directory
      // (e.g. `/__pyric/ui/docs` or `/__pyric/ui/docs/<slug>`) redirects to the
      // trailing-slash form so the directory's index.html loads with correct
      // relative-URL resolution.
      if (!rel.endsWith('/') && !extname(rel)) {
        const dir = join(opts.docsUiDir, decodeURIComponent(rel));
        if (existsSync(dir) && statSync(dir).isDirectory()) {
          res.writeHead(301, { location: `${url.pathname}/` }).end();
          return true;
        }
      }
      const file = resolveStaticFile(opts.docsUiDir, rel);
      if (!file) {
        res.writeHead(404).end('not found');
        return true;
      }
      res.writeHead(200, { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    if (
      opts.studioUiDir &&
      (url.pathname === '/__pyric/ui' || url.pathname.startsWith('/__pyric/ui/'))
    ) {
      // The built Pyric Studio app. Served verbatim (NOT through
      // injectServeTags: that import-map/init injection is for sandbox pages,
      // not Studio). Studio uses History-API routing under this mount, so any
      // path that doesn't resolve to a real file falls back to index.html —
      // INCLUDING paths with dots (deep links like /storage/uploads/logo.png).
      // Only misses under Vite's content-hashed asset dir stay hard 404s, so a
      // broken script/style URL fails loudly instead of returning HTML.
      if (url.pathname === '/__pyric/ui') {
        res.writeHead(301, { location: '/__pyric/ui/' }).end();
        return true;
      }
      const rel = url.pathname.slice('/__pyric/ui'.length) || '/';
      let file = resolveStaticFile(opts.studioUiDir, rel);
      if (!file && !rel.startsWith('/assets/')) {
        file = resolveStaticFile(opts.studioUiDir, '/index.html');
      }
      if (!file) {
        res.writeHead(404).end('not found');
        return true;
      }
      res.writeHead(200, { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    return false; // unknown /__pyric/* → caller 404s
  };
}

// ─── HTML injection ───────────────────────────────────────────────────

/** The import-map targets. Spec → served URL. */
export function sdkImportMap(): Record<string, string> {
  return {
    'firebase/ai': '/__pyric/sdk/ai.js',
    'firebase/app': '/__pyric/sdk/app.js',
    'firebase/auth': '/__pyric/sdk/auth.js',
    'firebase/database': '/__pyric/sdk/database.js',
    'firebase/firestore': '/__pyric/sdk/firestore.js',
    'firebase/storage': '/__pyric/sdk/storage.js',
  };
}

/**
 * Inject the import map + init script into an HTML document. The import map
 * MUST precede any module script that imports a mapped specifier, so both
 * tags go at the very start of `<head>` (fallbacks: after `<html>`, else
 * prepended). Idempotent — a page already carrying the marker is untouched
 * (matters when transformHtml runs over an SPA fallback repeatedly).
 */
export function injectServeTags(
  html: string,
  importMap: Record<string, string> = sdkImportMap(),
  workerVersion?: string,
  forceInPage = false,
): string {
  const MARKER = 'data-pyric-serve';
  if (html.includes(MARKER)) return html;
  // A pyric SANDBOX BUILD (`vite build` under the pyricSandbox plugin's sandbox
  // mode) already BUNDLES its own runtime + init chunk — injecting the import
  // map + /__pyric/sdk/init.js on top would boot a SECOND runtime instance on
  // the page (two banners, two bridge peer registrations, races between them).
  // The bundle owns the sandbox for a marked page: it fetches
  // /__pyric/init.json itself (worker path: the SharedWorker does; in-page
  // path: the runtime does) and owns rules hot-reload the same way. The ONLY
  // serve-time contribution left is the worker-version staleness stamp, which
  // the bundled runtime reads from this meta to warn about a stale
  // still-running SharedWorker.
  if (html.includes(SANDBOX_BUILD_MARKER)) {
    if (!workerVersion || html.includes('pyric-worker-v')) return html;
    const meta = `<meta name="pyric-worker-v" content="${workerVersion}" ${MARKER}>`;
    const headTag = html.match(/<head[^>]*>/i);
    if (headTag && headTag.index !== undefined) {
      const at = headTag.index + headTag[0].length;
      return html.slice(0, at) + meta + html.slice(at);
    }
    return meta + html;
  }
  // Stamp the worker's content hash so the page can DETECT staleness: a live
  // SharedWorker survives serve restarts + reloads and can't hot-update, so it
  // keeps running old code until every tab of the origin closes. The worker
  // name is intentionally STABLE (one backend shared by all tabs), so rather
  // than split tabs across versions, `runtime.ts` compares this served hash to
  // the running worker's baked hash and warns the user to close all tabs.
  const versionMeta = workerVersion
    ? `<meta name="pyric-worker-v" content="${workerVersion}" ${MARKER}>`
    : '';
  // `--bridge`: the MCP bridge peers with the IN-PAGE sandbox, so force the page
  // off the default SharedWorker path. Otherwise the agent drives an empty
  // in-page sandbox while the app's data lives in the worker. Set before any app
  // code runs; mirrors the Vite plugin's transformIndexHtml.
  const forceTag = forceInPage
    ? `<script ${MARKER}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`
    : '';
  const tags =
    versionMeta +
    forceTag +
    `<script type="importmap" ${MARKER}>${JSON.stringify({ imports: importMap })}</script>` +
    `<script type="module" src="/__pyric/sdk/init.js" ${MARKER}></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag && htmlTag.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  return tags + html;
}
