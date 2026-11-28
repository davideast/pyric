/**
 * The HTTP `onRequest` family: v2 `onRequest` and v1 `https.onRequest`
 * exports, read from the `__endpoint.httpsTrigger` manifest both set.
 */
import {
  resolveEndpointRegionsOption,
  resolveInvokerOption,
  resolveTimeoutSecondsOption,
} from '../endpoint-options.js';
import {
  classifyEndpointOmit,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import type { ParamsEnvMap } from '../params-resolver.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';

/** The handler an onRequest export is: express's `(req, res)`. */
export type HttpRequestHandler = (req: unknown, res: unknown) => unknown;

/** Firebase's region when neither the options nor setGlobalOptions name one. */
export const DEFAULT_REGION = 'us-central1';

/** What the host needs to route to one function; it crosses IPC, so it is plain data. */
export interface HttpFunctionInfo {
  exportName: string;
  /** Trigger kind when served on the HTTP listener; omitted defaults to `'http'`. */
  kind?: 'http' | 'callable';
  /** Every region the function deploys to; it answers under each. */
  regions: string[];
  platform: 'gcfv1' | 'gcfv2';
  /**
   * True when production lets only IAM callers invoke the function:
   * `invoker: 'private'` or a service account. pyric serves it anyway
   * (functions-http#15).
   */
  privateInvoker: boolean;
  /** The declared `timeoutSeconds`, or null for the platform default. */
  timeoutSeconds: number | null;
  /** Owning codebase when discovered in a multi-codebase or named-codebase project. */
  codebase?: string;
}

export interface DiscoveredOnRequest extends HttpFunctionInfo {
  handler: HttpRequestHandler;
}

export interface InspectHttpFunctionsOptions {
  env?: ParamsEnvMap;
}

function isHttpsEndpoint(endpoint: FirebaseEndpoint): boolean {
  const trigger = endpoint.httpsTrigger;
  return typeof trigger === 'object' && trigger !== null;
}

/**
 * firebase-tools grants `allUsers` only to a list that contains 'public'
 * (`getInvokerMembers`); any other list, such as 'private' or a service
 * account, binds just those members. No invoker leaves the function public.
 */
function isPrivateInvokerList(invoker: readonly string[] | undefined): boolean {
  if (!Array.isArray(invoker) || invoker.length === 0) return false;
  const grantsAllUsers = invoker.includes('public') && !invoker.includes('private');
  return !grantsAllUsers;
}

/** Every onRequest export, v1 and v2, in export order. */
export function inspectOnRequest(
  exported: Record<string, unknown>,
  options: InspectHttpFunctionsOptions = {},
): DiscoveredOnRequest[] {
  const env = options.env;
  const discovered: DiscoveredOnRequest[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isHttpsEndpoint(endpoint)) continue;
    if (classifyEndpointOmit(endpoint.omit, env) !== 'active') continue;
    const parsedRegions = resolveEndpointRegionsOption(endpoint.region, DEFAULT_REGION, env);
    if (!parsedRegions.ok) continue;
    const parsedTimeout = resolveTimeoutSecondsOption(endpoint.timeoutSeconds, env, {
      allowZero: true,
    });
    if (!parsedTimeout.ok) continue;
    const parsedInvoker = resolveInvokerOption(endpoint.httpsTrigger?.invoker, env);
    if (!parsedInvoker.ok) continue;
    discovered.push({
      exportName,
      regions: parsedRegions.regions,
      platform: endpoint.platform === 'gcfv1' ? 'gcfv1' : 'gcfv2',
      privateInvoker: isPrivateInvokerList(parsedInvoker.invoker),
      timeoutSeconds: parsedTimeout.timeoutSeconds ?? null,
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

/** The HTTP family claims every endpoint with an `httpsTrigger` and reports omitted ones. */
export const httpOnRequestFamily: FunctionsTriggerFamily = {
  claims: isHttpsEndpoint,
  unsupported: (exported, env) => {
    const unsupported: Array<{ exportName: string; eventType: string }> = [];
    for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
      const endpoint = callable.__endpoint;
      if (!endpoint || !isHttpsEndpoint(endpoint)) continue;
      const omitState = classifyEndpointOmit(endpoint.omit, env);
      if (omitState === 'omitted') {
        unsupported.push({ exportName, eventType: 'https (omitted from emulation)' });
        continue;
      }
      if (omitState === 'dynamic') {
        unsupported.push({ exportName, eventType: 'https (unsupported dynamic omit option)' });
        continue;
      }
      if (!resolveEndpointRegionsOption(endpoint.region, DEFAULT_REGION, env).ok) {
        unsupported.push({ exportName, eventType: 'https (unsupported dynamic region option)' });
        continue;
      }
      if (!resolveTimeoutSecondsOption(endpoint.timeoutSeconds, env, { allowZero: true }).ok) {
        unsupported.push({
          exportName,
          eventType: 'https (unsupported dynamic timeoutSeconds option)',
        });
        continue;
      }
      if (!resolveInvokerOption(endpoint.httpsTrigger?.invoker, env).ok) {
        unsupported.push({ exportName, eventType: 'https (unsupported dynamic invoker option)' });
      }
    }
    return unsupported;
  },
};
