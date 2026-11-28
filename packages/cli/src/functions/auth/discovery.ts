/**
 * Discovery and manifest validation for Gen 1 Firebase Auth user lifecycle
 * triggers (`functions.auth.user().onCreate()` and `.onDelete()`):
 * `providers/firebase.auth/eventTypes/user.create` and `user.delete`.
 */
import {
  resolveBooleanOption,
  resolveEndpointRegionsOption,
  resolveTimeoutSecondsOption,
} from '../endpoint-options.js';
import {
  classifyEndpointOmit,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import type { ParamsEnvMap } from '../params-resolver.js';
import type { FunctionsTriggerFamily, UnsupportedFunctionsTrigger } from '../unsupported.js';

export const AUTH_USER_CREATED_EVENT_TYPE = 'providers/firebase.auth/eventTypes/user.create';
export const AUTH_USER_DELETED_EVENT_TYPE = 'providers/firebase.auth/eventTypes/user.delete';

export const AUTH_LIFECYCLE_EVENT_TYPES = [
  AUTH_USER_CREATED_EVENT_TYPE,
  AUTH_USER_DELETED_EVENT_TYPE,
] as const;

export type AuthLifecycleEventType = (typeof AUTH_LIFECYCLE_EVENT_TYPES)[number];
export type AuthLifecycleOperation = 'create' | 'delete';

const AUTH_LIFECYCLE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUTH_LIFECYCLE_EVENT_TYPES);
const DEFAULT_AUTH_REGION = 'us-central1';

export type AuthLifecycleTriggerCallable = (
  data: Record<string, unknown>,
  context: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DiscoveredAuthLifecycleTrigger {
  exportName: string;
  eventType: AuthLifecycleEventType;
  operation: AuthLifecycleOperation;
  retry: boolean;
  location?: string;
  timeoutSeconds?: number;
  callable: AuthLifecycleTriggerCallable;
}

export interface AuthLifecycleTriggerInspection {
  triggers: DiscoveredAuthLifecycleTrigger[];
  unsupported: UnsupportedFunctionsTrigger[];
}

export interface InspectAuthLifecycleTriggersOptions {
  env?: ParamsEnvMap;
}

export function isAuthLifecycleEventType(value: unknown): value is AuthLifecycleEventType {
  return typeof value === 'string' && AUTH_LIFECYCLE_EVENT_TYPE_SET.has(value);
}

function classifyOperation(eventType: AuthLifecycleEventType): AuthLifecycleOperation {
  return eventType === AUTH_USER_CREATED_EVENT_TYPE ? 'create' : 'delete';
}

/** Inspect exported functions for Gen 1 Auth `user.create` and `user.delete` triggers. */
export function inspectAuthLifecycleTriggers(
  exported: Record<string, unknown>,
  options: InspectAuthLifecycleTriggersOptions = {},
): AuthLifecycleTriggerInspection {
  const env = options.env;
  const triggers: DiscoveredAuthLifecycleTrigger[] = [];
  const unsupported: UnsupportedFunctionsTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<AuthLifecycleTriggerCallable>(
    exported,
  )) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    const eventType = trigger?.eventType;
    if (!isAuthLifecycleEventType(eventType)) continue;

    const omitState = classifyEndpointOmit(endpoint?.omit, env);
    if (omitState === 'omitted') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (omitted from emulation)`,
      });
      continue;
    }
    if (omitState === 'dynamic') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic omit option)`,
      });
      continue;
    }

    const parsedLocation = resolveEndpointRegionsOption(
      endpoint?.region,
      DEFAULT_AUTH_REGION,
      env,
    );
    if (!parsedLocation.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic region option)`,
      });
      continue;
    }

    const parsedTimeout = resolveTimeoutSecondsOption(endpoint?.timeoutSeconds, env);
    if (!parsedTimeout.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic timeoutSeconds option)`,
      });
      continue;
    }

    const rawRetry = (trigger as Record<string, unknown> | undefined)?.retry;
    const parsedRetry = resolveBooleanOption(rawRetry, env);
    if (!parsedRetry.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic retry option)`,
      });
      continue;
    }

    const discovered: DiscoveredAuthLifecycleTrigger = {
      exportName,
      eventType,
      operation: classifyOperation(eventType),
      retry: parsedRetry.value,
      callable,
    };
    if (parsedLocation.explicit && parsedLocation.location !== undefined) {
      discovered.location = parsedLocation.location;
    }
    if (parsedTimeout.timeoutSeconds !== undefined) {
      discovered.timeoutSeconds = parsedTimeout.timeoutSeconds;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Discover valid Gen 1 Auth lifecycle triggers admitted for execution. */
export function discoverAuthLifecycleTriggers(
  exported: Record<string, unknown>,
  options: InspectAuthLifecycleTriggersOptions = {},
): DiscoveredAuthLifecycleTrigger[] {
  return inspectAuthLifecycleTriggers(exported, options).triggers;
}

/** Claims Gen 1 `providers/firebase.auth/eventTypes/user.create` and `user.delete` endpoints. */
export const authLifecycleTriggersFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) =>
    isAuthLifecycleEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported, env) =>
    inspectAuthLifecycleTriggers(exported, env === undefined ? {} : { env }).unsupported,
};
