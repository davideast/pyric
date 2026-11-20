/**
 * The callable `onCall` family: v2 `onCall` and v1 `https.onCall` exports,
 * read from the `__endpoint.callableTrigger` manifest both set.
 *
 * Each export is already `firebase-functions`'s `onCallHandler` Express
 * function (`lib/common/providers/https.js`), so the child HTTP server mounts
 * it unchanged alongside `onRequest` exports.
 */
import { listFirebaseEndpoints, type FirebaseEndpoint } from '../endpoints.js';
import {
  DEFAULT_REGION,
  type DiscoveredOnRequest,
  type HttpRequestHandler,
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

function regionsOf(endpoint: FirebaseEndpoint): string[] {
  const rawRegions = endpoint.region;
  if (!Array.isArray(rawRegions)) return [DEFAULT_REGION];
  const declared = rawRegions.filter(
    (region): region is string => typeof region === 'string' && region.length > 0,
  );
  if (declared.length > 0) return declared;
  return [DEFAULT_REGION];
}

function platformOf(endpoint: FirebaseEndpoint): 'gcfv1' | 'gcfv2' {
  if (endpoint.platform === 'gcfv1') return 'gcfv1';
  return 'gcfv2';
}

function timeoutOf(endpoint: FirebaseEndpoint): number | null {
  const timeout = endpoint.timeoutSeconds;
  if (typeof timeout === 'number' && timeout > 0) return timeout;
  return null;
}

/** Every supported onCall export, v1 and v2, in export order. */
export function inspectOnCall(exported: Record<string, unknown>): DiscoveredOnRequest[] {
  const discovered: DiscoveredOnRequest[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isCallableEndpoint(endpoint)) continue;
    if (endpoint.omit !== undefined && endpoint.omit !== false) continue;
    if (isGenkitCallable(endpoint)) continue;
    discovered.push({
      exportName,
      kind: 'callable',
      regions: regionsOf(endpoint),
      platform: platformOf(endpoint),
      privateInvoker: false,
      timeoutSeconds: timeoutOf(endpoint),
      handler: callable,
    });
  }
  return discovered;
}

/** Claims every endpoint with a `callableTrigger` and reports omitted or Genkit ones. */
export const callableOnCallFamily: FunctionsTriggerFamily = {
  claims: isCallableEndpoint,
  unsupported: (exported) => {
    const unsupported: Array<{ exportName: string; eventType: string }> = [];
    for (const { exportName, callable } of listFirebaseEndpoints<HttpRequestHandler>(exported)) {
      const endpoint = callable.__endpoint;
      if (!endpoint || !isCallableEndpoint(endpoint)) continue;
      if (endpoint.omit === true) {
        unsupported.push({ exportName, eventType: 'callable (omitted from emulation)' });
      } else if (endpoint.omit !== undefined && endpoint.omit !== false) {
        unsupported.push({ exportName, eventType: 'callable (unsupported dynamic omit option)' });
      } else if (isGenkitCallable(endpoint)) {
        unsupported.push({ exportName, eventType: 'callable (onCallGenkit is not supported)' });
      }
    }
    return unsupported;
  },
};
