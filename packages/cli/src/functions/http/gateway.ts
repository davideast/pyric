/**
 * The one place a plane hands an HTTP request to the Functions runtime.
 * `pyric sandbox` calls it from its static server and the Vite plugin from its
 * middleware stack, so both planes route, refuse, and forward identically.
 *
 * The gateway tracks the runtime's lifecycle. While the child is starting,
 * reloading, or waiting for a sandbox peer, a matched route answers 503 naming
 * why (functions-http#20) instead of falling through to a static 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FunctionsChildHttpReady } from '../child-protocol.js';
import type { HttpFunctionInfo } from './discovery.js';
import { refuseForeignOrigin, type AppOriginCheck } from './private-origin.js';
import { proxyToChild } from './proxy.js';
import { matchEmulatorPath, type FunctionRoute } from './routes.js';
import { unavailableReason, type FunctionsPlane } from './unavailable.js';

export type { AppOriginCheck } from './private-origin.js';
export type { FunctionsPlane } from './unavailable.js';

export type FunctionsHttpState =
  /** Waiting for a sandbox peer before the first start. */
  | { kind: 'waiting-peer'; serveUrl: string }
  /** No peer connected within the start's wait. */
  | { kind: 'peer-timeout'; serveUrl: string }
  | { kind: 'starting' }
  | { kind: 'reloading' }
  | { kind: 'failed'; message: string }
  /** The child stopped beating; the runtime is restarting it. */
  | { kind: 'unresponsive' }
  /** The child exited after it was ready. */
  | { kind: 'exited'; code: number }
  | { kind: 'stopped' }
  | { kind: 'ready'; http: FunctionsChildHttpReady | null };

export interface FunctionsHttpGatewayOptions {
  projectId: string;
  initial: FunctionsHttpState;
  plane: FunctionsPlane;
}

export interface FunctionsHttpGateway {
  /**
   * Handle the request if it is for a function; false lets the plane carry on.
   * `allowsAppOrigin` is the plane's Origin check, applied to private functions.
   */
  handle(req: IncomingMessage, res: ServerResponse, allowsAppOrigin: AppOriginCheck): Promise<boolean>;
  update(state: FunctionsHttpState): void;
  state(): FunctionsHttpState;
}

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' };

function routeFor(rawUrl: string, projectId: string, state: FunctionsHttpState): FunctionRoute | null {
  const functions = state.kind === 'ready' ? state.http?.functions ?? [] : null;
  return matchEmulatorPath(rawUrl, { projectId, functions });
}

/** firebase-tools' 404 for an unknown trigger key (`functionsEmulator.js:1239-1243`). */
function notFoundText(key: string, functions: readonly HttpFunctionInfo[]): string {
  const keys = functions.flatMap((fn) => fn.regions.map((region) => `${region}-${fn.exportName}`));
  return `Function ${key} does not exist, valid functions are: ${keys.join(', ')}`;
}

/** A GET or HEAD may be for a static file under a directory named after the project id. */
function mayBeStaticRead(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

export function createFunctionsHttpGateway(options: FunctionsHttpGatewayOptions): FunctionsHttpGateway {
  let current = options.initial;
  return {
    state: () => current,
    update(state) {
      current = state;
    },
    async handle(req, res, allowsAppOrigin) {
      const state = current;
      const route = routeFor(req.url ?? '/', options.projectId, state);
      if (route === null) return false;
      const reason = unavailableReason(state, options.plane);
      if (reason !== null) {
        res.writeHead(503, { ...PLAIN_TEXT, 'retry-after': '1' }).end(reason);
        return true;
      }
      const http = state.kind === 'ready' ? state.http : null;
      if (http === null || route.kind === 'emulator-path') return false;
      if (route.kind === 'unknown-function') {
        if (mayBeStaticRead(req)) return false;
        res.writeHead(404, PLAIN_TEXT).end(notFoundText(route.key, http.functions));
        return true;
      }
      if (refuseForeignOrigin(req, res, route.fn, allowsAppOrigin)) return true;
      await proxyToChild(req, res, {
        port: http.port,
        token: http.token,
        exportName: route.fn.exportName,
        forwardUrl: route.forwardUrl,
      });
      return true;
    },
  };
}
