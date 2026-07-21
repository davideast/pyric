/**
 * `pyric dev` static server — the hosting half of the command.
 *
 * Bare `node:http` (house style — the bridge does the same; no superstatic
 * dependency). Serves `hosting.public` from `firebase.json` with the minimal
 * rewrite the local-dev case needs (`** → /index.html` SPA fallback when
 * configured), and exposes two seams the `/__pyric/` namespace plugs into
 * (`namespaceHandler`) and the import-map injection uses (`transformHtml`).
 *
 * UX parity targets: the `=== Serving from` banner, the labeled `Local server:`
 * line, port 3473 default ("FIRE" on a phone keypad) with scan-forward on conflict, and SIGINT →
 * `Shutting down...`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface ServeLogger {
  /** User-facing lines (banner, URLs) → stdout. */
  info(message: string): void;
  /** Lifecycle/diagnostics (requests, warnings) → stderr. */
  note(message: string): void;
}

export function consoleServeLogger(): ServeLogger {
  return {
    info: (m) => console.log(m),
    note: (m) => console.error(m),
  };
}

export function silentServeLogger(): ServeLogger {
  return { info: () => {}, note: () => {} };
}

/** `--json` mode: the whole human banner moves to stderr so stdout carries
 *  exactly one machine-readable line (the agent contract). */
export function stderrServeLogger(): ServeLogger {
  return {
    info: (m) => console.error(m),
    note: (m) => console.error(m),
  };
}

export interface StaticServerOptions {
  /** Directory to serve. Caller resolves it from firebase.json (or cwd). */
  publicDir: string;
  port?: number;
  host?: string;
  /** SPA fallback: unmatched extension-less GETs serve /index.html. */
  spaRewrite?: boolean;
  /** Handles reserved routes (the `/__pyric/` namespace). Return true when
   *  the request was handled. */
  namespaceHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
  /** Applied to every served `.html` body (import-map/init injection). */
  transformHtml?: (html: string) => string;
  logger?: ServeLogger;
  /** How many sequential ports to try past `port` on EADDRINUSE/EACCES. */
  portScanLimit?: number;
  /** Extra hostnames allowed past the DNS-rebinding guard (besides
   *  localhost/127.0.0.1/[::1]/the bound host). `--allowed-host`. */
  allowedHosts?: string[];
}

/**
 * DNS-rebinding guard. A dev server bound to localhost is reachable by any
 * webpage whose hostname resolves to 127.0.0.1 (`attacker.com` → A
 * 127.0.0.1): the victim's browser then treats `http://attacker.com:PORT`
 * as same-origin to the attacker's page and can read/write our endpoints —
 * including `/__pyric/state` (auth users + plaintext passwords, and writes).
 * Vite addresses the same class with `server.allowedHosts`.
 *
 * We accept only loopback hostnames + the host the server was bound to +
 * any `--allowed-host`. A request with NO Host header is allowed (curl /
 * same-origin fetches omit nothing in practice, but non-browser clients may;
 * the attack requires a browser sending the attacker's Host).
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  boundHost: string,
  extra: string[] = [],
): boolean {
  if (!hostHeader) return true; // no Host → not a browser rebinding attack
  const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = new Set(
    ['localhost', '127.0.0.1', '::1', '0.0.0.0', boundHost.toLowerCase(), ...extra.map((h) => h.toLowerCase())],
  );
  return allowed.has(hostname);
}

/**
 * Origin allowlist for WebSocket `upgrade` handshakes. A browser sends an
 * `Origin` header on WS handshakes carrying the page's origin; a hostile page
 * that opens a WS to our loopback bridge sends ITS OWN cross-origin Origin,
 * which we reject — otherwise the page hijacks the agent tool channel
 * (`registerSandboxPeer` last-wins). We reuse `isAllowedHost`'s allow rule on
 * the Origin's hostname (loopback names + bound host + `--allowed-host`).
 *
 * A missing `Origin` is allowed: the same-origin/non-browser peer (a CLI ws
 * client, a test) is not the hijack vector, which requires a browser attaching
 * the attacker's Origin. A malformed Origin is rejected.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  boundHost: string,
  extra: string[] = [],
): boolean {
  if (!originHeader) return true; // no Origin → non-browser client, not a hijack
  let hostname: string;
  try {
    hostname = new URL(originHeader).hostname; // may be `[::1]` — isAllowedHost strips brackets
  } catch {
    return false; // malformed Origin → reject
  }
  return isAllowedHost(hostname, boundHost, extra);
}

/**
 * The combined guard for a WS `upgrade` request: BOTH the `Host` header
 * (DNS-rebinding) AND the `Origin` header (cross-origin hijack) must pass.
 * `upgrade` is a separate listener from the HTTP `request` event, so the
 * static server's request-time `isAllowedHost` never runs on it — every
 * upgrade mount point must call this before `wss.handleUpgrade`.
 */
export function isAllowedUpgrade(
  headers: { host?: string; origin?: string },
  boundHost: string,
  extra: string[] = [],
): boolean {
  return (
    isAllowedHost(headers.host, boundHost, extra) &&
    isAllowedOrigin(headers.origin, boundHost, extra)
  );
}

export interface ServeHandle {
  port: number;
  host: string;
  url: string;
  /** The primary bound server. For the default `localhost` host this is the
   *  IPv4 (127.0.0.1) listener; see `servers` for all of them. */
  server: Server;
  /** Every bound server. For `localhost` the server binds BOTH loopback
   *  families (127.0.0.1 + ::1) so any client reaches it; callers that wire a
   *  WS upgrade (the bridge) must attach to each. One entry for an explicit host. */
  servers: Server[];
  stop(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Decode a URL pathname for static-file lookup. Malformed escapes are misses. */
export function decodeStaticPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** Resolve a request path inside `publicDir`, refusing malformed or escaping paths. */
export function resolveStaticPath(publicDir: string, pathname: string): string | null {
  const decoded = decodeStaticPathname(pathname);
  if (decoded === null) return null;
  const root = resolve(publicDir);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null; // traversal
  return candidate;
}

/** Resolve an existing static file inside `publicDir`. */
export function resolveStaticFile(publicDir: string, pathname: string): string | null {
  let file = resolveStaticPath(publicDir, pathname);
  if (file === null) return null;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

/**
 * Stream a file to a response with the read stream's `'error'` event handled.
 * A bare `createReadStream(file).pipe(res)` leaves the stream's error event
 * unhandled — an fs error between the exists-check and the read (file swapped
 * out, EMFILE under fd pressure, EISDIR race) then throws at the event-loop
 * level and KILLS the whole serve process. Headers are usually already sent
 * when the stream errors, so the recovery is: log, destroy the response (the
 * client sees a truncated body), keep the server alive.
 */
export function pipeFileToResponse(
  file: string,
  res: ServerResponse,
  onError?: (err: Error) => void,
): void {
  const stream = createReadStream(file);
  // Read-side failures keep the old contract: log via onError and, when
  // headers haven't gone out yet, answer 500. (Attached BEFORE pipeline so
  // it runs ahead of pipeline's own teardown of `res`.)
  stream.on('error', (err: Error) => {
    onError?.(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('read error');
    }
  });
  // stream.pipeline (not a bare .pipe) so a failure on EITHER side tears both
  // streams down: a client abort mid-download now destroys the read stream
  // (closing its fd — the hole .pipe left open), and a mid-stream read
  // failure destroys the response (the client sees a truncated body), all
  // without an event-loop-level 'error' escaping.
  pipeline(stream, res, () => {
    // Errors on both sides are consumed by the handler above / the teardown
    // itself; the callback's existence is what keeps the process alive.
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StaticServerOptions,
  logger: ServeLogger,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // DNS-rebinding guard (before ANY handling — protects static files,
  // init.json/rules schema, and especially /__pyric/state credentials).
  if (!isAllowedHost(req.headers.host, opts.host ?? 'localhost', opts.allowedHosts)) {
    logger.note(`  ✖ 403 blocked Host '${req.headers.host}' (DNS-rebinding guard)`);
    res.writeHead(403, { 'content-type': 'text/plain' }).end(
      `pyric dev: refused request for Host '${req.headers.host ?? ''}'. ` +
        'Only localhost is allowed; use --allowed-host to add one.',
    );
    return;
  }

  if (opts.namespaceHandler && url.pathname.startsWith('/__pyric/')) {
    const handled = await opts.namespaceHandler(req, res, url);
    if (handled) return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  let file = resolveStaticFile(opts.publicDir, url.pathname);
  if (!file && opts.spaRewrite && !extname(url.pathname)) {
    file = resolveStaticFile(opts.publicDir, '/index.html');
  }
  if (!file && url.pathname === '/favicon.ico') {
    // The browser requests /favicon.ico on every load; without this an app
    // that ships no favicon logs a 404 in every console. Serve a tiny inline
    // SVG (a neutral placeholder square — the real mark comes with the logo
    // work) so consoles stay clean. An on-disk favicon.ico was already
    // resolved above and wins.
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="#e8e8ee"/></svg>',
    );
    return;
  }
  if (!file) {
    logger.note(`  ✖ 404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const type = contentTypeFor(file);
  logger.note(`  • ${req.method} ${url.pathname}`);

  if (type.startsWith('text/html') && opts.transformHtml) {
    const { readFile } = await import('node:fs/promises');
    const html = opts.transformHtml(await readFile(file, 'utf8'));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }

  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeFileToResponse(file, res, (e) => logger.note(`  ✖ read failed ${url.pathname}: ${e.message}`));
}

/** The subset of `Server` the scan logic needs — injectable for tests
 *  (bun's sockets allow same-port rebinds on macOS, so real-socket conflict
 *  tests are runtime-dependent; node, the npx production runtime, raises
 *  EADDRINUSE as expected). */
export interface ListenableLike {
  listen(port: number, host: string, cb: () => void): unknown;
  once(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
  removeListener(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
  address(): { port: number } | string | null;
}

/** Listen, scanning forward from `port` on conflict (default 3473 avoids macOS AirPlay, which squats 5000 on
 *  macOS). Resolves with the bound port. */
export function listenWithScan(
  server: ListenableLike,
  host: string,
  port: number,
  limit: number,
  logger: ServeLogger,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let attempt = port;
    const tryListen = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        if (port !== 0 && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt - port < limit) {
          logger.note(`  ⚠ port ${attempt} is in use${attempt === 5000 ? ' (macOS AirPlay commonly holds 5000)' : ''} — trying ${attempt + 1}`);
          attempt += 1;
          tryListen();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(attempt, host, () => {
        server.removeListener('error', onError);
        // Read the BOUND port — `attempt` may be 0 (ephemeral, tests).
        const addr = server.address();
        resolvePort(typeof addr === 'object' && addr ? addr.port : attempt);
      });
    };
    tryListen();
  });
}

/**
 * Loopback families to bind for `host`. The default `localhost` binds BOTH
 * 127.0.0.1 (IPv4) and ::1 (IPv6) so a client using either reaches the server:
 * `localhost` resolves to only ONE family, so the other 404s at the socket (the
 * IPv4/IPv6 loopback trap). An explicit host binds only itself. Loopback
 * families only — NEVER all-interfaces — so the sandbox stays off the LAN behind
 * the DNS-rebinding guard.
 */
export function loopbackHosts(host: string): string[] {
  return host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
}

export async function startStaticServer(opts: StaticServerOptions): Promise<ServeHandle> {
  const logger = opts.logger ?? consoleServeLogger();
  const host = opts.host ?? 'localhost';
  const hosts = loopbackHosts(host);

  // Track sockets so stop() can sever long-lived connections (SSE,
  // keep-alive) on runtimes without `closeAllConnections` (bun) — otherwise
  // `server.close()` waits forever on an open event stream.
  const sockets = new Set<import('node:net').Socket>();
  const newServer = (): Server => {
    const s = createServer((req, res) => {
      void handleRequest(req, res, opts, logger).catch((e) => {
        logger.note(`  ✖ 500 ${req.url}: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end('internal error');
      });
    });
    s.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return s;
  };

  // Primary family: scan forward for a free port.
  const primary = newServer();
  const port = await listenWithScan(primary, hosts[0]!, opts.port ?? 3473, opts.portScanLimit ?? 10, logger);

  // Remaining loopback families: bind the SAME port, best-effort. A loopback
  // port free on one family is virtually always free on the other; if not, warn
  // and keep going (the primary still serves) rather than fail the whole serve.
  const servers: Server[] = [primary];
  for (const h of hosts.slice(1)) {
    const extra = newServer();
    try {
      await new Promise<void>((res2, rej) => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          extra.removeListener('error', onErr);
          rej(e);
        };
        extra.once('error', onErr);
        extra.listen(port, h, () => {
          extra.removeListener('error', onErr);
          res2();
        });
      });
      servers.push(extra);
    } catch (e) {
      logger.note(`  ⚠ could not also bind ${h}:${port} (${e instanceof Error ? e.message : String(e)}) — ${hosts[0]} still serves`);
    }
  }

  const url = `http://${host}:${port}`;
  return {
    port,
    host,
    url,
    server: primary,
    servers,
    stop: () =>
      new Promise<void>((resolveStop, rejectStop) => {
        let pending = servers.length;
        let failed: Error | null = null;
        for (const s of servers) {
          s.close((e) => {
            if (e && !failed) failed = e;
            if (--pending === 0) (failed ? rejectStop(failed) : resolveStop());
          });
          // Don't wait on keep-alive/SSE sockets during shutdown. Node has
          // closeAllConnections; bun doesn't — destroy tracked sockets too.
          s.closeAllConnections?.();
        }
        for (const socket of sockets) socket.destroy();
      }),
  };
}
