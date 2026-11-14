/**
 * `pyric dev` static server -- the hosting half of the command.
 *
 * Bare `node:http` (house style -- the bridge does the same; no superstatic
 * dependency). Serves `hosting.public` from `firebase.json` with the minimal
 * rewrite the local-dev case needs (`** -> /index.html` SPA fallback when
 * configured), and exposes two seams the `/__pyric/` namespace plugs into
 * (`namespaceHandler`) and the import-map injection uses (`transformHtml`).
 *
 * UX parity targets: the `=== Serving from` banner, the labeled `Local server:`
 * line, port 3473 default ("FIRE" on a phone keypad) with scan-forward on conflict, and SIGINT ->
 * `Shutting down...`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isHostingIgnoredPathname, isHostingIgnoredRealFile } from './hosting-ignore.js';
import { registerLocalSessionToken } from './local-session-token.js';
import {
  appendSetCookieHeader,
  canBootstrapHtmlSession,
  formatSessionCookie,
  getHeader,
  isAllowedHost,
  isAllowedLoopbackRequest,
  isAllowedOrigin,
  isAllowedOriginOnPorts,
  isAllowedSessionToken,
  isAllowedUpgrade,
  isForeignFetchSite,
  isForeignFetchWithoutOrigin,
  isLocalPeer,
  isLoopbackAddress,
  PYRIC_SESSION_COOKIE_NAME,
  requestSocketScheme,
  sessionCookieNameForPort,
  timingSafeTokenMatch,
} from './loopback-guard.js';

export {
  appendSetCookieHeader,
  canBootstrapHtmlSession,
  formatSessionCookie,
  getHeader,
  isAllowedHost,
  isAllowedLoopbackRequest,
  isAllowedOrigin,
  isAllowedOriginOnPorts,
  isAllowedSessionToken,
  isAllowedUpgrade,
  isForeignFetchSite,
  isForeignFetchWithoutOrigin,
  isLocalPeer,
  isLoopbackAddress,
  PYRIC_SESSION_COOKIE_NAME,
  requestSocketScheme,
  sessionCookieNameForPort,
  timingSafeTokenMatch,
};

export interface ServeLogger {
  /** User-facing lines (banner, URLs) -> stdout. */
  info(message: string): void;
  /** Lifecycle/diagnostics (requests, warnings) -> stderr. */
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
  /** Directory to serve: firebase.json's `hosting.public`. `null` serves no
   *  static site, as production has no Hosting site without a `hosting` block. */
  publicDir: string | null;
  port?: number;
  host?: string;
  /** SPA fallback: unmatched extension-less GETs serve /index.html. */
  spaRewrite?: boolean;
  /** Redirect root `/` to `/__pyric/ui/studio` when no static `index.html` exists.
   *  Defaults to true when `namespaceHandler` is present. */
  redirectRootToStudio?: boolean;
  /** Handles reserved routes (the `/__pyric/` namespace). Return true when
   *  the request was handled. */
  namespaceHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
  /** Handles Functions HTTP routes after the namespace and before static
   *  files and the GET/HEAD-only 405. Return true when the request was handled. */
  functionsHandler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
  /** Applied to every served `.html` body (import-map/init injection). */
  transformHtml?: (html: string, context: { localPeer: boolean }) => string;
  /** Session capability token minted for this boot; set as an HttpOnly `/__pyric`
   *  cookie on local-peer HTML responses so same-origin browser/worker requests authenticate. */
  sessionToken?: string;
  logger?: ServeLogger;
  /** How many sequential ports to try past `port` on EADDRINUSE/EACCES. */
  portScanLimit?: number;
  /** Extra hostnames allowed past the DNS-rebinding guard (besides
   *  localhost/127.0.0.1/[::1]/the bound host). `--allowed-host`. */
  allowedHosts?: string[];
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

/** Resolve a static file the hosting plane may serve: never one production
 *  Hosting's default `ignore` leaves out of a deploy (#1779). */
export function resolveHostingFile(publicDir: string, pathname: string): string | null {
  if (isHostingIgnoredPathname(pathname)) return null;
  const file = resolveStaticFile(publicDir, pathname);
  if (file === null) return null;
  // The request path passed; the file it opens must too, after links resolve.
  if (isHostingIgnoredRealFile(publicDir, file)) return null;
  return file;
}

/**
 * Stream a file to a response with the read stream's `'error'` event handled.
 * A bare `createReadStream(file).pipe(res)` leaves the stream's error event
 * unhandled -- an fs error between the exists-check and the read (file swapped
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
  stream.on('error', (err: Error) => {
    onError?.(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('read error');
    }
  });
  pipeline(stream, res, () => {});
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StaticServerOptions,
  logger: ServeLogger,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // DNS-rebinding guard (before ANY handling -- protects static files,
  // init.json/rules schema, and especially /__pyric/state credentials).
  if (!isAllowedHost(req.headers.host, opts.host ?? 'localhost', opts.allowedHosts)) {
    logger.note(`  ✖ 403 blocked Host '${req.headers.host}' (DNS-rebinding guard)`);
    res.writeHead(403, { 'content-type': 'text/plain' }).end(
      `pyric sandbox: refused request for Host '${req.headers.host ?? ''}'. ` +
        'Only localhost is allowed; use --allowed-host to add one.',
    );
    return;
  }

  if (opts.namespaceHandler && url.pathname.startsWith('/__pyric/')) {
    const handled = await opts.namespaceHandler(req, res, url);
    if (handled) return;
  }

  if (opts.functionsHandler && !url.pathname.startsWith('/__pyric/')) {
    const handled = await opts.functionsHandler(req, res);
    if (handled) return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  const publicDir = opts.publicDir;
  const servesSite = publicDir !== null;
  let file: string | null = null;
  if (servesSite) {
    file = resolveHostingFile(publicDir, url.pathname);
  }
  if (servesSite && !file && opts.spaRewrite && !extname(url.pathname)) {
    file = resolveHostingFile(publicDir, '/index.html');
  }
  if (!file && url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="#e8e8ee"/></svg>');
    }
    return;
  }
  const shouldRedirectRoot = opts.redirectRootToStudio ?? Boolean(opts.namespaceHandler);
  if (!file && url.pathname === '/' && shouldRedirectRoot) {
    const target = `/__pyric/ui/studio${url.search}`;
    logger.note(`  • 302 ${req.method} ${url.pathname} → ${target}`);
    res.writeHead(302, { location: target }).end();
    return;
  }
  if (!file) {
    logger.note(`  ✖ 404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const type = contentTypeFor(file);
  logger.note(`  • ${req.method} ${url.pathname}`);

  if (type.startsWith('text/html')) {
    const canBootstrap = canBootstrapHtmlSession(req, opts.host ?? 'localhost');
    const effectiveSessionToken =
      opts.sessionToken ?? (opts.namespaceHandler as { sessionToken?: string } | undefined)?.sessionToken;
    if (effectiveSessionToken && canBootstrap) {
      appendSetCookieHeader(res, formatSessionCookie(effectiveSessionToken));
    }
    if (opts.transformHtml) {
      const { readFile } = await import('node:fs/promises');
      const html = opts.transformHtml(await readFile(file, 'utf8'), { localPeer: canBootstrap });
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
  }

  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeFileToResponse(file, res, (e) => logger.note(`  ✖ read failed ${url.pathname}: ${e.message}`));
}

/** The subset of `Server` the scan logic needs -- injectable for tests. */
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
          const airplayNote = attempt === 5000 ? ' (macOS AirPlay commonly holds 5000)' : '';
          logger.note(`  ⚠ port ${attempt} is in use${airplayNote} — trying ${attempt + 1}`);
          attempt += 1;
          tryListen();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(attempt, host, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolvePort(addr.port);
        } else {
          resolvePort(attempt);
        }
      });
    };
    tryListen();
  });
}

/**
 * Loopback families to bind for `host`. The default `localhost` binds BOTH
 * 127.0.0.1 (IPv4) and ::1 (IPv6) so a client using either reaches the server.
 */
export function loopbackHosts(host: string): string[] {
  if (host === 'localhost') return ['127.0.0.1', '::1'];
  return [host];
}

export async function startStaticServer(opts: StaticServerOptions): Promise<ServeHandle> {
  const logger = opts.logger ?? consoleServeLogger();
  const host = opts.host ?? 'localhost';
  const hosts = loopbackHosts(host);

  const sockets = new Set<import('node:net').Socket>();
  const newServer = (): Server => {
    const s = createServer((req, res) => {
      void handleRequest(req, res, opts, logger).catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        logger.note(`  ✖ 500 ${req.url}: ${message}`);
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

  const primary = newServer();
  const port = await listenWithScan(primary, hosts[0]!, opts.port ?? 3473, opts.portScanLimit ?? 10, logger);

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
      const message = e instanceof Error ? e.message : String(e);
      logger.note(`  ⚠ could not also bind ${h}:${port} (${message}) — ${hosts[0]} still serves`);
    }
  }

  const url = `http://${host}:${port}`;
  let unregisterToken: (() => void) | undefined;
  if (opts.sessionToken) {
    unregisterToken = registerLocalSessionToken(port, opts.sessionToken);
  }
  return {
    port,
    host,
    url,
    server: primary,
    servers,
    stop: () =>
      new Promise<void>((resolveStop, rejectStop) => {
        unregisterToken?.();
        let pending = servers.length;
        let failed: Error | null = null;
        for (const s of servers) {
          s.close((e) => {
            if (e && !failed) failed = e;
            pending -= 1;
            if (pending === 0) {
              if (failed) rejectStop(failed);
              else resolveStop();
            }
          });
          s.closeAllConnections?.();
        }
        for (const socket of sockets) socket.destroy();
      }),
  };
}
