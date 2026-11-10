import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { ViteDevServer } from 'vite';
import { answerMountClosed, HEALTH_PATH, type BridgeMount } from './bridge-mount.js';
import type { SandboxSession } from './sandbox-session.js';
import { appendSetCookieHeader, formatSessionCookie, isAllowedHost, isLocalPeer } from './server.js';

const viteHtmlPeerStorage = new AsyncLocalStorage<{ localPeer: boolean }>();

/** Current Vite dev request peer context while `transformIndexHtml` runs, if inside a request. */
export function currentViteHtmlPeerContext(): { localPeer: boolean } | undefined {
  return viteHtmlPeerStorage.getStore();
}

/**
 * Wraps Vite dev page navigations in `viteHtmlPeerStorage` and sets the
 * `HttpOnly; SameSite=Strict; Path=/__pyric` session cookie on local-peer HTML requests.
 */
export function attachViteHtmlSessionBootstrap(
  server: Pick<ViteDevServer, 'middlewares'>,
  getSessionToken: () => string | undefined,
): void {
  server.middlewares.use((req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
    const localPeer = isLocalPeer(req);
    const token = getSessionToken();
    const method = req.method ?? 'GET';
    if (localPeer && token && (method === 'GET' || method === 'HEAD')) {
      const path = requestPath(req);
      const ext = extname(path).toLowerCase();
      const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
      const isHtmlNavigation =
        !path.startsWith('/__pyric/') &&
        (accept.includes('text/html') || ext === '' || ext === '.html' || ext === '.htm');
      if (isHtmlNavigation) {
        appendSetCookieHeader(res, formatSessionCookie(token));
      }
    }
    viteHtmlPeerStorage.run({ localPeer }, next);
  });
}

/** The request's path, from the URL before Connect stripped the `/__pyric` mount. */
function requestPath(req: IncomingMessage & { originalUrl?: string }): string {
  const raw = req.originalUrl ?? req.url ?? '/';
  const queryAt = raw.indexOf('?');
  return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/**
 * Live generations per Connect stack. A restarted Vite server gets a new
 * stack, so the old server's stack has none while its replacement starts. A
 * plugin configured twice on one server stacks both generations, and the
 * live one answers.
 */
const liveGenerations = new WeakMap<object, number>();

function adjustLive(stack: object, by: number): void {
  liveGenerations.set(stack, (liveGenerations.get(stack) ?? 0) + by);
}

/** Attach one generation's guarded namespace handler to Vite's permanent Connect stack. */
export function attachViteGenerationMiddleware(input: {
  server: ViteDevServer;
  bridge: BridgeMount | null;
  session: SandboxSession;
}): () => void {
  const { server, bridge, session } = input;
  const serverOptions = server.config.server;
  const stack = server.middlewares;
  let active = true;
  adjustLive(stack, 1);

  server.middlewares.use(
    '/__pyric',
    (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
      if (!active) {
        // With no live generation on this stack, a closed generation's mount
        // still says it is closing, as the mount itself does once closed, so
        // `pyric run --wait` waits for the restarted server instead of
        // reading Vite's 404 as "not a host" (#1568).
        const isHealthRequest = requestPath(req) === HEALTH_PATH;
        const hasLiveGeneration = (liveGenerations.get(stack) ?? 0) > 0;
        const answersClosing = bridge !== null && isHealthRequest && !hasLiveGeneration;
        if (answersClosing) {
          answerMountClosed(res);
          return;
        }
        next();
        return;
      }
      const allowed = isAllowedHost(
        req.headers.host,
        typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost',
        Array.isArray(serverOptions.allowedHosts) ? serverOptions.allowedHosts : [],
      );
      if (!allowed) {
        res.statusCode = 403;
        res.end(`pyric: refused request for Host '${req.headers.host ?? ''}' (DNS-rebinding guard).`);
        return;
      }
      const url = new URL(
        req.originalUrl ?? req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`,
      );
      let bridgeResult: boolean | Promise<boolean> = false;
      if (bridge) bridgeResult = bridge.handler(req, res, url);
      Promise.resolve(bridgeResult)
        .then((bridged) => {
          if (bridged) return true;
          return session.handle(req, res, url);
        })
        .then((handled) => {
          if (!handled) next();
        })
        .catch((error: unknown) => {
          if (!res.headersSent) res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        });
    },
  );

  return () => {
    if (!active) return;
    active = false;
    adjustLive(stack, -1);
  };
}
