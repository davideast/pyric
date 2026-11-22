/**
 * The HTTP server inside the isolated Functions child. It builds an express
 * app from the express that the user's own firebase-functions install depends
 * on, with the request parsing and per-generation body limits the Cloud
 * Functions runtime applies (`functions-framework-nodejs` `src/server.ts` plus
 * 10 MiB 1st-gen / 32 MiB 2nd-gen quotas), and hands each request to the
 * export the host named. The host proxies every plane to this one listener,
 * and only the host's proxy may reach it: a request without the spawn's token
 * gets 403 before anything else runs.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, type Gunzip, type Inflate } from 'node:zlib';
import { timingSafeTokenMatch } from '../../serve/server.js';
import { CHILD_TOKEN_HEADER } from './child-token.js';
import type { DiscoveredOnRequest } from './discovery.js';

/** The request header the host sets to name the export a request is for. */
export const FUNCTION_TARGET_HEADER = 'x-pyric-function-target';

/** Cloud Functions 1st-gen max uncompressed HTTP request size (10 MiB). */
export const MAX_V1_HTTP_BODY_BYTES = 10 * 1024 * 1024;

/** Cloud Functions 2nd-gen max uncompressed HTTP request size (32 MiB). */
export const MAX_V2_HTTP_BODY_BYTES = 32 * 1024 * 1024;

export function maxHttpBodyBytes(platform: 'gcfv1' | 'gcfv2'): number {
  if (platform === 'gcfv1') {
    return MAX_V1_HTTP_BODY_BYTES;
  }
  return MAX_V2_HTTP_BODY_BYTES;
}

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

interface ParserOptions {
  limit: number;
  verify(req: IncomingMessage, res: ServerResponse, body: Buffer): void;
  type?: string;
  extended?: boolean;
}

interface ExpressApp {
  set(setting: string, value: unknown): void;
  disable(setting: string): void;
  enable(setting: string): void;
  use(handler: Middleware): void;
  listen(port: number, host: string, callback: () => void): Server;
}

interface ExpressModule {
  (): ExpressApp;
  json(options: ParserOptions): Middleware;
  text(options: ParserOptions): Middleware;
  urlencoded(options: ParserOptions): Middleware;
  raw(options: ParserOptions): Middleware;
}

/**
 * How long a stop or reload waits for in-flight requests before closing them.
 * The host force-kills the child 2 s after asking it to stop, so this stays under that.
 */
const DRAIN_MS = 1_000;

export interface HttpChildServerOptions {
  /** The spawn's token; every request must carry it in CHILD_TOKEN_HEADER. */
  token: string;
  drainMs?: number;
}

export interface HttpChildServer {
  port: number;
  close(): Promise<void>;
}

/** The express that the user's firebase-functions resolves, so the request objects are the ones its wrappers expect. */
function loadExpress(entry: string): ExpressModule {
  const functionsMain = createRequire(entry).resolve('firebase-functions');
  return createRequire(functionsMain)('express') as ExpressModule;
}

function saveRawBody(req: IncomingMessage, _res: ServerResponse, body: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = body;
}

/** Removes a header from both views express gives a function, `headers` and `rawHeaders`. */
function dropHeader(req: IncomingMessage, name: string): void {
  delete req.headers[name];
  const raw = req.rawHeaders;
  for (let at = raw.length - 2; at >= 0; at -= 2) {
    const headerName = raw[at];
    const isNamed = headerName !== undefined && headerName.toLowerCase() === name;
    if (isNamed) raw.splice(at, 2);
  }
}

/**
 * Answer 413 Payload Too Large before reading the full request body and close
 * the socket cleanly after briefly draining in-flight loopback bytes so fast
 * clients read the 413 response rather than seeing ECONNRESET.
 */
export function answerPayloadTooLarge(req: IncomingMessage, res: ServerResponse): void {
  const socket = req.socket;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const send413 = (): void => {
    if (res.headersSent) return;
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    res.useChunkedEncodingByDefault = false;
    res.writeHead(413, {
      'content-type': 'text/plain; charset=utf-8',
      connection: 'close',
    });
    res.end('Payload Too Large', () => {
      socket?.end();
    });
  };
  if (req.complete || req.readableEnded) {
    send413();
    return;
  }
  drainTimer = setTimeout(send413, 100);
  drainTimer.unref();
  req.once('end', send413);
  req.once('close', send413);
  req.once('error', send413);
  req.resume();
}

function parseContentLength(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizedContentEncoding(req: IncomingMessage): string {
  const raw = req.headers['content-encoding'];
  if (typeof raw !== 'string') return 'identity';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return 'identity';
  return trimmed;
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  return (
    candidate.status === 413 ||
    candidate.statusCode === 413 ||
    candidate.type === 'entity.too.large'
  );
}

function isRequestAbortedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { type?: unknown; code?: unknown };
  return candidate.type === 'request.aborted' || candidate.code === 'ECONNABORTED';
}

function buildBodyParsers(express: ExpressModule, limitBytes: number): Middleware[] {
  const parser = { limit: limitBytes, verify: saveRawBody };
  return [
    express.json({ ...parser, type: 'application/cloudevents+json' }),
    express.json(parser),
    express.text(parser),
    express.urlencoded({ ...parser, extended: true }),
    express.raw({ ...parser, type: '*/*' }),
  ];
}

function runMiddlewareChain(
  middlewares: readonly Middleware[],
  req: IncomingMessage,
  res: ServerResponse,
  done: (error?: unknown) => void,
): void {
  let index = 0;
  const step = (error?: unknown): void => {
    if (error !== undefined) {
      done(error);
      return;
    }
    if (res.writableEnded || res.headersSent) {
      return;
    }
    const current = middlewares[index];
    index += 1;
    if (!current) {
      done();
      return;
    }
    try {
      current(req, res, step);
    } catch (caught) {
      done(caught);
    }
  };
  step();
}

/**
 * When `Content-Type` is absent, `body-parser` skips the request (leaving
 * `req.body` and `req.rawBody` undefined). Enforce `limitBytes` on the
 * uncompressed request stream while keeping `req.body` and `req.rawBody`
 * untouched for requests within the quota.
 */
function guardUntypedRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  limitBytes: number,
  onAllowed: () => void,
): void {
  if (req.headers['content-type'] !== undefined) {
    onAllowed();
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD' || req.readableEnded) {
    onAllowed();
    return;
  }
  const encoding = normalizedContentEncoding(req);
  const declaredLength = parseContentLength(req.headers['content-length']);
  if (encoding === 'identity' && declaredLength !== null) {
    if (declaredLength > limitBytes) {
      answerPayloadTooLarge(req, res);
      return;
    }
    onAllowed();
    return;
  }

  const wireChunks: Buffer[] = [];
  let uncompressedBytes = 0;
  let settled = false;
  let decoder: Gunzip | Inflate | null = null;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = createGunzip();
  } else if (encoding === 'deflate') {
    decoder = createInflate();
  }

  const rejectTooLarge = (): void => {
    if (settled) return;
    settled = true;
    wireChunks.length = 0;
    decoder?.destroy();
    answerPayloadTooLarge(req, res);
  };

  if (decoder !== null) {
    decoder.on('data', (chunk: Buffer) => {
      uncompressedBytes += chunk.byteLength;
      if (uncompressedBytes > limitBytes) {
        rejectTooLarge();
      }
    });
    decoder.on('error', () => {
      if (settled) return;
      settled = true;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
    });
  }

  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    if (decoder !== null) {
      wireChunks.push(chunk);
      decoder.write(chunk);
      return;
    }
    uncompressedBytes += chunk.byteLength;
    if (uncompressedBytes > limitBytes) {
      rejectTooLarge();
      return;
    }
    wireChunks.push(chunk);
  });

  req.on('error', () => {
    if (settled) return;
    settled = true;
    decoder?.destroy();
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
    }
  });

  const finishAllowed = (): void => {
    if (settled) return;
    settled = true;
    if (wireChunks.length > 0) {
      const replay = Readable.from(wireChunks);
      req.on = replay.on.bind(replay) as IncomingMessage['on'];
      req.once = replay.once.bind(replay) as IncomingMessage['once'];
      req.pipe = replay.pipe.bind(replay) as IncomingMessage['pipe'];
      (req as unknown as { [Symbol.asyncIterator]: typeof replay[typeof Symbol.asyncIterator] })[
        Symbol.asyncIterator
      ] = replay[Symbol.asyncIterator].bind(replay);
    }
    onAllowed();
  };

  req.on('end', () => {
    if (settled) return;
    if (decoder !== null) {
      decoder.once('end', finishAllowed);
      decoder.end();
      return;
    }
    finishAllowed();
  });
}

/**
 * Refuses any caller but the host's proxy, before body parsing or dispatch,
 * and strips the token so the function never sees it.
 */
function requireToken(token: string): Middleware {
  return (req, res, next) => {
    const presented = req.headers[CHILD_TOKEN_HEADER];
    dropHeader(req, CHILD_TOKEN_HEADER);
    const isFromProxy = typeof presented === 'string' && timingSafeTokenMatch(presented, token);
    if (!isFromProxy) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('pyric: the Functions child answers only the pyric proxy. Call the function through the URL pyric printed.');
      return;
    }
    next();
  };
}

function invokeHandler(fn: DiscoveredOnRequest, req: IncomingMessage, res: ServerResponse): void {
  const answer500 = (): void => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = 500;
    res.end('Internal Server Error');
  };
  try {
    void Promise.resolve(fn.handler(req, res)).catch(answer500);
  } catch {
    // Synchronous handler throw maps to HTTP 500 matching Cloud Functions runtime.
    answer500();
  }
}

function dispatch(
  express: ExpressModule,
  functions: ReadonlyMap<string, DiscoveredOnRequest>,
): Middleware {
  const v1Parsers = buildBodyParsers(express, MAX_V1_HTTP_BODY_BYTES);
  const v2Parsers = buildBodyParsers(express, MAX_V2_HTTP_BODY_BYTES);

  return (req, res, next) => {
    const target = req.headers[FUNCTION_TARGET_HEADER];
    dropHeader(req, FUNCTION_TARGET_HEADER);
    const fn = typeof target === 'string' ? functions.get(target) : undefined;
    if (!fn) {
      res.statusCode = 404;
      res.end(`Function ${String(target)} does not exist in this Functions source.`);
      return;
    }

    const limitBytes = maxHttpBodyBytes(fn.platform);
    const encoding = normalizedContentEncoding(req);
    const declaredLength = parseContentLength(req.headers['content-length']);
    if (encoding === 'identity' && declaredLength !== null && declaredLength > limitBytes) {
      answerPayloadTooLarge(req, res);
      return;
    }

    let parsers = v2Parsers;
    if (fn.platform === 'gcfv1') {
      parsers = v1Parsers;
    }

    runMiddlewareChain(parsers, req, res, (parseError) => {
      if (parseError !== undefined) {
        if (isPayloadTooLargeError(parseError)) {
          answerPayloadTooLarge(req, res);
          return;
        }
        if (isRequestAbortedError(parseError)) {
          if (!res.headersSent) {
            res.statusCode = 400;
            res.end();
          }
          return;
        }
        next(parseError);
        return;
      }
      guardUntypedRequestBody(req, res, limitBytes, () => {
        invokeHandler(fn, req, res);
      });
    });
  };
}

/** Stop accepting, let in-flight requests finish until `drainMs`, then close what is left. */
function drainAndClose(server: Server, sockets: ReadonlySet<Socket>, drainMs: number): Promise<void> {
  return new Promise<void>((resolveClose) => {
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, drainMs);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      resolveClose();
    });
    server.closeIdleConnections?.();
  });
}

/** Listen on an ephemeral loopback port and serve the discovered onRequest exports. */
export function startHttpChildServer(
  entry: string,
  discovered: readonly DiscoveredOnRequest[],
  options: HttpChildServerOptions,
): Promise<HttpChildServer> {
  const express = loadExpress(entry);
  const app = express();
  // Cloud Functions runs with NODE_ENV=production, so express's error pages carry no stack or file paths.
  app.set('env', 'production');
  app.disable('x-powered-by');
  // One trusted hop: the host's proxy, which appends the client to X-Forwarded-For.
  // req.ip is then the client the proxy saw, never an address the client claimed.
  app.set('trust proxy', 1);
  app.use(requireToken(options.token));
  app.use(dispatch(express, new Map(discovered.map((fn) => [fn.exportName, fn]))));

  return new Promise((resolveServer, rejectServer) => {
    const sockets = new Set<Socket>();
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        port,
        close: () => drainAndClose(server, sockets, options.drainMs ?? DRAIN_MS),
      });
    });
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.once('error', rejectServer);
  });
}
