/**
 * The callable `onCall` family: v2 `onCall` and v1 `https.onCall` exports,
 * read from the `__endpoint.callableTrigger` manifest both set.
 *
 * Each export is already `firebase-functions`'s `onCallHandler` Express
 * function (`lib/common/providers/https.js`), so the child HTTP server mounts
 * it unchanged alongside `onRequest` exports.
 */
import {
  resolveEndpointRegionsOption,
  resolveTimeoutSecondsOption,
} from '../endpoint-options.js';
import {
  classifyEndpointOmit,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import {
  DEFAULT_REGION,
  type DiscoveredOnRequest,
  type HttpRequestHandler,
  type InspectHttpFunctionsOptions,
} from '../http/discovery.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';

interface CallableTriggerManifest {
  genkitAction?: unknown;
}

function isCallableEndpoint(endpoint: FirebaseEndpoint): boolean {
  const trigger = endpoint.callableTrigger;
  return typeof trigger === 'object' && trigger !== null;
}

function isGenkitCallable(endpoint: FirebaseEndpoint): boolean {
  if (!isCallableEndpoint(endpoint)) return false;
  const trigger = endpoint.callableTrigger as CallableTriggerManifest;
  return trigger.genkitAction !== undefined;
}

function platformOf(endpoint: FirebaseEndpoint): 'gcfv1' | 'gcfv2' {
  if (endpoint.platform === 'gcfv1') return 'gcfv1';
  return 'gcfv2';
}

/** Every supported onCall export, v1 and v2, in export order. */
export function inspectOnCall(
  exported: Record<string, unknown>,
  options: InspectHttpFunctionsOptions = {},
): DiscoveredOnRequest[] {
  const env = options.env;
  const discovered: DiscoveredOnRequest[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isCallableEndpoint(endpoint)) continue;
    if (classifyEndpointOmit(endpoint.omit, env) !== 'active') continue;
    if (isGenkitCallable(endpoint)) continue;
    const parsedRegions = resolveEndpointRegionsOption(endpoint.region, DEFAULT_REGION, env);
    if (!parsedRegions.ok) continue;
    const parsedTimeout = resolveTimeoutSecondsOption(endpoint.timeoutSeconds, env, {
      allowZero: true,
    });
    if (!parsedTimeout.ok) continue;
    discovered.push({
      exportName,
      kind: 'callable',
      regions: parsedRegions.regions,
      platform: platformOf(endpoint),
      privateInvoker: false,
      timeoutSeconds: parsedTimeout.timeoutSeconds ?? null,
      handler: callable,
    });
  }
  return discovered;
}

/** Claims every endpoint with a `callableTrigger` and reports omitted or Genkit ones. */
export const callableOnCallFamily: FunctionsTriggerFamily = {
  claims: isCallableEndpoint,
  unsupported: (exported, env) => {
    const unsupported: Array<{ exportName: string; eventType: string }> = [];
    for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
      const endpoint = callable.__endpoint;
      if (!endpoint || !isCallableEndpoint(endpoint)) continue;
      const omitState = classifyEndpointOmit(endpoint.omit, env);
      if (omitState === 'omitted') {
        unsupported.push({ exportName, eventType: 'callable (omitted from emulation)' });
        continue;
      }
      if (omitState === 'dynamic') {
        unsupported.push({ exportName, eventType: 'callable (unsupported dynamic omit option)' });
        continue;
      }
      if (isGenkitCallable(endpoint)) {
        unsupported.push({ exportName, eventType: 'callable (onCallGenkit is not supported)' });
        continue;
      }
      if (!resolveEndpointRegionsOption(endpoint.region, DEFAULT_REGION, env).ok) {
        unsupported.push({ exportName, eventType: 'callable (unsupported dynamic region option)' });
        continue;
      }
      if (!resolveTimeoutSecondsOption(endpoint.timeoutSeconds, env, { allowZero: true }).ok) {
        unsupported.push({
          exportName,
          eventType: 'callable (unsupported dynamic timeoutSeconds option)',
        });
      }
    }
    return unsupported;
  },
};
