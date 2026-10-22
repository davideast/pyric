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
import { proxyToChild } from './proxy.js';
import { matchEmulatorPath, unknownFunctionMessage, type FunctionRoute } from './routes.js';

export type FunctionsHttpState =
  | { kind: 'waiting-peer'; serveUrl: string }
  | { kind: 'starting' }
  | { kind: 'reloading' }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }
  | { kind: 'ready'; http: FunctionsChildHttpReady | null };

export interface FunctionsHttpGatewayOptions {
  projectId: string;
  initial: FunctionsHttpState;
}

export interface FunctionsHttpGateway {
  /** Handle the request if it is for a function; false lets the plane carry on. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  update(state: FunctionsHttpState): void;
  state(): FunctionsHttpState;
}

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' };

/** Why a matched route cannot be served now; null once the child is ready. */
function unavailableReason(state: FunctionsHttpState): string | null {
  switch (state.kind) {
    case 'waiting-peer':
      return `Functions are not running yet: no browser tab is connected to pyric sandbox. Open ${state.serveUrl} to start them.`;
    case 'starting':
      return 'Functions are starting. Retry in a moment.';
    case 'reloading':
      return 'Functions are reloading after a source change. Retry in a moment.';
    case 'failed':
      return `Functions failed to start: ${state.message}`;
    case 'stopped':
      return 'Functions are stopped.';
    case 'ready':
      return null;
  }
}

function routeFor(rawUrl: string, projectId: string, state: FunctionsHttpState): FunctionRoute | null {
  const functions = state.kind === 'ready' ? state.http?.functions ?? [] : null;
  return matchEmulatorPath(rawUrl, { projectId, functions });
}

export function createFunctionsHttpGateway(options: FunctionsHttpGatewayOptions): FunctionsHttpGateway {
  let current = options.initial;
  return {
    state: () => current,
    update(state) {
      current = state;
    },
    async handle(req, res) {
      const state = current;
      const route = routeFor(req.url ?? '/', options.projectId, state);
      if (route === null) return false;
      const reason = unavailableReason(state);
      if (reason !== null) {
        res.writeHead(503, { ...PLAIN_TEXT, 'retry-after': '1' }).end(reason);
        return true;
      }
      const http = state.kind === 'ready' ? state.http : null;
      if (route.kind !== 'function' || http === null) {
        const key = route.kind === 'unknown-function' ? route.key : 'unknown';
        res.writeHead(404, PLAIN_TEXT).end(unknownFunctionMessage(key, http?.functions ?? []));
        return true;
      }
      await proxyToChild(req, res, { port: http.port, exportName: route.fn.exportName, forwardUrl: route.forwardUrl });
      return true;
    },
  };
}
