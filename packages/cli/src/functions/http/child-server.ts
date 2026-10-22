/**
 * The HTTP server inside the isolated Functions child. It builds an express
 * app from the express that the user's own firebase-functions install depends
 * on, with the request parsing the Cloud Functions runtime applies
 * (functions-framework-nodejs `src/server.ts`), and hands each request to the
 * export the host named. The host proxies every plane to this one listener.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import type { DiscoveredOnRequest } from './discovery.js';

/** The request header the host sets to name the export a request is for. */
export const FUNCTION_TARGET_HEADER = 'x-pyric-function-target';

/** functions-framework-nodejs accepts 1024mb; Cloud Run caps a request at 32 MiB first. */
const BODY_LIMIT = '32mb';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

interface ParserOptions {
  limit: string;
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
  drainMs?: number;
}

export interface HttpChildServer {
  port: number;
  close(): Promise<void>;
}

/** The express that the user's firebase-functions resolves, so the request objects are the ones its wrappers expect. */
function loadExpress(entry: string): ExpressModule {
  // firebase-functions' `exports` map hides package.json; its main entry sits inside the same install.
  const functionsMain = createRequire(entry).resolve('firebase-functions');
  return createRequire(functionsMain)('express') as ExpressModule;
}

function saveRawBody(req: IncomingMessage, _res: ServerResponse, body: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = body;
}

function dispatch(functions: ReadonlyMap<string, DiscoveredOnRequest>): Middleware {
  return (req, res) => {
    const target = req.headers[FUNCTION_TARGET_HEADER];
    delete req.headers[FUNCTION_TARGET_HEADER];
    const fn = typeof target === 'string' ? functions.get(target) : undefined;
    if (!fn) {
      res.statusCode = 404;
      res.end(`Function ${String(target)} does not exist in this Functions source.`);
      return;
    }
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
      answer500();
    }
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
  options: HttpChildServerOptions = {},
): Promise<HttpChildServer> {
  const express = loadExpress(entry);
  const app = express();
  // Cloud Functions runs with NODE_ENV=production, so express's error pages carry no stack or file paths.
  app.set('env', 'production');
  app.disable('x-powered-by');
  // One trusted hop: the host's proxy, which appends the client to X-Forwarded-For.
  // req.ip is then the client the proxy saw, never an address the client claimed.
  app.set('trust proxy', 1);
  const parser = { limit: BODY_LIMIT, verify: saveRawBody };
  app.use(express.json({ ...parser, type: 'application/cloudevents+json' }));
  app.use(express.json(parser));
  app.use(express.text(parser));
  app.use(express.urlencoded({ ...parser, extended: true }));
  app.use(express.raw({ ...parser, type: '*/*' }));
  app.use(dispatch(new Map(discovered.map((fn) => [fn.exportName, fn]))));

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
