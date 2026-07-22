import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { BridgeMount } from './bridge-mount.js';
import type { SandboxSession } from './sandbox-session.js';
import { isAllowedHost } from './server.js';

/** Attach one generation's guarded namespace handler to Vite's permanent Connect stack. */
export function attachViteGenerationMiddleware(input: {
  server: ViteDevServer;
  bridge: BridgeMount | null;
  session: SandboxSession;
}): () => void {
  const { server, bridge, session } = input;
  const serverOptions = server.config.server;
  let active = true;

  server.middlewares.use(
    '/__pyric',
    (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
      if (!active) {
        next();
        return;
      }
      const allowed = serverOptions.allowedHosts === true || isAllowedHost(
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
      Promise.resolve(bridge ? bridge.handler(req, res, url) : false)
        .then((bridged) => (bridged ? true : Promise.resolve(session.handle(req, res, url))))
        .then((handled) => {
          if (!handled) next();
        })
        .catch((error: unknown) => {
          if (!res.headersSent) res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        });
    },
  );

  return () => { active = false; };
}
