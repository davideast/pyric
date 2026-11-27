/**
 * The endpoints a development session will not run, and why.
 *
 * Each trigger family the child serves registers here: it claims the
 * endpoints of its kind and reports the ones of its kind it still refuses
 * (an unsupported pattern, an omitted export). Every endpoint no family
 * claims is reported under its trigger label, so a new family is one entry
 * in the list the child passes, not another branch in a label chain.
 */
import {
  classifyEndpointOmit,
  endpointTriggerLabel,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from './endpoints.js';
import type { ParamsEnvMap } from './params-resolver.js';

export interface UnsupportedFunctionsTrigger {
  exportName: string;
  eventType: string;
}

export interface FunctionsTriggerFamily {
  /** Whether this family owns an endpoint, served or refused. */
  claims(endpoint: FirebaseEndpoint): boolean;
  /** The endpoints this family owns but refuses, in export order. */
  unsupported(
    exported: Record<string, unknown>,
    env?: ParamsEnvMap,
  ): UnsupportedFunctionsTrigger[];
}

export interface FindUnsupportedTriggersOptions {
  env?: ParamsEnvMap;
}

/** Every endpoint the given families refuse or do not claim, families first. */
export function findUnsupportedTriggers(
  exported: Record<string, unknown>,
  families: readonly FunctionsTriggerFamily[],
  options: FindUnsupportedTriggersOptions = {},
): UnsupportedFunctionsTrigger[] {
  const env = options.env;
  const unsupported = families.flatMap((family) => family.unsupported(exported, env));
  for (const { exportName, callable } of listFirebaseEndpoints(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint) continue;
    const claimed = families.some((family) => family.claims(endpoint));
    if (claimed) continue;
    const label = endpointTriggerLabel(endpoint);
    const omitState = classifyEndpointOmit(endpoint.omit, env);
    if (omitState === 'omitted') {
      unsupported.push({ exportName, eventType: `${label} (omitted from emulation)` });
      continue;
    }
    if (omitState === 'dynamic') {
      unsupported.push({ exportName, eventType: `${label} (unsupported dynamic omit option)` });
      continue;
    }
    unsupported.push({ exportName, eventType: label });
  }
  return unsupported;
}
