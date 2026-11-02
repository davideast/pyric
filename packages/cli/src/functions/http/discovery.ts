/**
 * The HTTP `onRequest` family: v2 `onRequest` and v1 `https.onRequest`
 * exports, read from the `__endpoint.httpsTrigger` manifest both set.
 */
import { listFirebaseEndpoints, type FirebaseEndpoint } from '../endpoints.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';

/** The handler an onRequest export is: express's `(req, res)`. */
export type HttpRequestHandler = (req: unknown, res: unknown) => unknown;

/** Firebase's region when neither the options nor setGlobalOptions name one. */
export const DEFAULT_REGION = 'us-central1';

/** What the host needs to route to one function; it crosses IPC, so it is plain data. */
export interface HttpFunctionInfo {
  exportName: string;
  /** Every region the function deploys to; it answers under each. */
  regions: string[];
  platform: 'gcfv1' | 'gcfv2';
  /** True for `invoker: 'private'`, which pyric serves anyway (functions-http#15). */
  privateInvoker: boolean;
  /** The declared `timeoutSeconds`, or null for the platform default. */
  timeoutSeconds: number | null;
}

export interface DiscoveredOnRequest extends HttpFunctionInfo {
  handler: HttpRequestHandler;
}

function isHttpsEndpoint(endpoint: FirebaseEndpoint): boolean {
  const trigger = endpoint.httpsTrigger;
  return typeof trigger === 'object' && trigger !== null;
}

function regionsOf(endpoint: FirebaseEndpoint): string[] {
  const declared = Array.isArray(endpoint.region)
    ? endpoint.region.filter((region): region is string => typeof region === 'string' && region.length > 0)
    : [];
  return declared.length > 0 ? declared : [DEFAULT_REGION];
}

function isPrivateInvoker(endpoint: FirebaseEndpoint): boolean {
  const invoker = endpoint.httpsTrigger?.invoker;
  return Array.isArray(invoker) && invoker.includes('private');
}

function timeoutOf(endpoint: FirebaseEndpoint): number | null {
  const timeout = endpoint.timeoutSeconds;
  return typeof timeout === 'number' && timeout > 0 ? timeout : null;
}

/** Every onRequest export, v1 and v2, in export order. */
export function inspectOnRequest(exported: Record<string, unknown>): DiscoveredOnRequest[] {
  const discovered: DiscoveredOnRequest[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isHttpsEndpoint(endpoint)) continue;
    discovered.push({
      exportName,
      regions: regionsOf(endpoint),
      platform: endpoint.platform === 'gcfv1' ? 'gcfv1' : 'gcfv2',
      privateInvoker: isPrivateInvoker(endpoint),
      timeoutSeconds: timeoutOf(endpoint),
      handler: callable,
    });
  }
  return discovered;
}

/** The plain-data view of a discovered function, for the ready message. */
export function httpFunctionInfo(discovered: DiscoveredOnRequest): HttpFunctionInfo {
  const { handler: _handler, ...info } = discovered;
  return info;
}

/** The HTTP family claims every endpoint with an `httpsTrigger` and refuses none of them. */
export const httpOnRequestFamily: FunctionsTriggerFamily = {
  claims: isHttpsEndpoint,
  unsupported: () => [],
};
