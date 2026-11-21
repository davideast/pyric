import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { createDiagnostics } from './diagnostics.js';
import type { RemoteAccessOptions } from './guard-policy.js';
import {
  evaluateNamespaceSurface,
  writeGuardRejection,
  type NamespaceGuardOptions,
} from './namespace-guards.js';
import { DIAGNOSTICS_PATH } from './runtime/diagnostics-report.js';
import { isAllowedHost } from './server.js';
import { hasLiveViteGeneration, viteRequestPath } from './vite-generation-middleware.js';

export interface VitePendingDiagnosticsPolicy {
  sessionToken: string;
  requireSessionToken: boolean;
  allowedHosts: readonly string[];
  remoteAccess?: RemoteAccessOptions;
}

/**
 * Synchronously attach a guarded `/__pyric/diagnostics` responder on Vite's
 * Connect stack before `configureServer` awaits generation startup (#2098).
 *
 * Once `attachViteGenerationMiddleware` mounts the live generation on the same
 * stack, `hasLiveViteGeneration` is true and this middleware yields immediately
 * via `next()`. Before `getPolicy()` resolves, requests fail closed by
 * requiring a capability token that nobody holds.
 */
export function attachVitePendingDiagnosticsMiddleware(
  server: Pick<ViteDevServer, 'middlewares'> & {
    config?: { server?: { host?: string | boolean; allowedHosts?: true | string[] } };
  },
  hosted: boolean,
  getPolicy: () => VitePendingDiagnosticsPolicy | undefined,
): void {
  const stack = server.middlewares;
  const fallbackToken = randomBytes(24).toString('base64url');
  const diagnostics = createDiagnostics(() => (hosted ? 'hosted' : 'browser'));

  server.middlewares.use(
    (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
      if (hasLiveViteGeneration(stack)) {
        next();
        return;
      }
      if (viteRequestPath(req) !== DIAGNOSTICS_PATH) {
        next();
        return;
      }
      const policy = getPolicy();
      const rawHost = server.config?.server?.host;
      const boundHost = typeof rawHost === 'string' ? rawHost : 'localhost';
      const extraAllowedHosts: string[] = [];
      const configuredHosts = server.config?.server?.allowedHosts;
      if (Array.isArray(configuredHosts)) {
        for (const entry of configuredHosts) {
          if (!extraAllowedHosts.includes(entry)) extraAllowedHosts.push(entry);
        }
      }
      for (const entry of policy?.allowedHosts ?? []) {
        if (!extraAllowedHosts.includes(entry)) extraAllowedHosts.push(entry);
      }
      if (!isAllowedHost(req.headers.host, boundHost, extraAllowedHosts)) {
        res.statusCode = 403;
        res.end(`pyric: refused request for Host '${req.headers.host ?? ''}' (DNS-rebinding guard).`);
        return;
      }
      const url = new URL(
        req.originalUrl ?? req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`,
      );
      const guardOpts: NamespaceGuardOptions = {
        boundHost,
        allowedHosts: extraAllowedHosts,
        sessionToken: policy?.sessionToken ?? fallbackToken,
        requireSessionToken: policy ? policy.requireSessionToken : true,
        remoteAccess: policy?.remoteAccess,
        remoteAccessEnabled: policy?.remoteAccess !== undefined,
      };
      const decision = evaluateNamespaceSurface(req, guardOpts, 'namespace', url);
      if (!decision.ok) {
        writeGuardRejection(res, decision, { nextPath: `${url.pathname}${url.search}` });
        return;
      }
      diagnostics(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    },
  );
}
