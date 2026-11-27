import {
  resolveBooleanOption,
  resolveEndpointRegionsOption,
  resolveStringOption,
  resolveTimeoutSecondsOption,
} from '../endpoint-options.js';
import {
  classifyEndpointOmit,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import { DEFAULT_REGION } from '../http/discovery.js';
import type { ParamsEnvMap } from '../params-resolver.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';
import {
  normalizeRtdbReference,
  supportsRtdbReference,
} from './reference-pattern.js';

type RtdbValueCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

type RtdbCreatedCallable = RtdbValueCallable;

export const CREATED_EVENT_TYPE = 'google.firebase.database.ref.v1.created';
export const UPDATED_EVENT_TYPE = 'google.firebase.database.ref.v1.updated';
export const DELETED_EVENT_TYPE = 'google.firebase.database.ref.v1.deleted';
export const WRITTEN_EVENT_TYPE = 'google.firebase.database.ref.v1.written';

export type RtdbValueEventType =
  | typeof CREATED_EVENT_TYPE
  | typeof UPDATED_EVENT_TYPE
  | typeof DELETED_EVENT_TYPE
  | typeof WRITTEN_EVENT_TYPE;

const RTDB_VALUE_EVENT_TYPES: readonly RtdbValueEventType[] = [
  CREATED_EVENT_TYPE,
  UPDATED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  WRITTEN_EVENT_TYPE,
];

const ALL_RTDB_VALUE_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(
  RTDB_VALUE_EVENT_TYPES,
);
const CREATED_ONLY_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>([
  CREATED_EVENT_TYPE,
]);

export interface DiscoveredOnValueCreated {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
  callable: RtdbCreatedCallable;
}

export interface DiscoveredRtdbValueTrigger extends DiscoveredOnValueCreated {
  eventType: RtdbValueEventType;
}

export interface UnsupportedOnValueCreated {
  exportName: string;
  eventType: string;
}

export interface RtdbValueTriggerInspection {
  triggers: DiscoveredRtdbValueTrigger[];
  unsupported: UnsupportedOnValueCreated[];
}

export interface OnValueCreatedInspection {
  triggers: DiscoveredOnValueCreated[];
  unsupported: UnsupportedOnValueCreated[];
}

export interface InspectRtdbTriggersOptions {
  env?: ParamsEnvMap;
}

function isRtdbValueEventType(value: unknown): value is RtdbValueEventType {
  return typeof value === 'string' && ALL_RTDB_VALUE_EVENT_TYPE_SET.has(value);
}

function inspectWithAllowedEventTypes(
  exported: Record<string, unknown>,
  allowedEventTypes: ReadonlySet<string>,
  options: InspectRtdbTriggersOptions = {},
): RtdbValueTriggerInspection {
  const env = options.env;
  const triggers: DiscoveredRtdbValueTrigger[] = [];
  const unsupported: UnsupportedOnValueCreated[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<RtdbValueCallable>(exported)) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    const eventType = trigger?.eventType;
    if (!isRtdbValueEventType(eventType) || !allowedEventTypes.has(eventType)) {
      continue;
    }
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
    const rawReference = trigger?.eventFilterPathPatterns?.ref ?? trigger?.eventFilters?.ref;
    const resolvedRef = resolveStringOption(rawReference, env);
    if (!resolvedRef.ok || resolvedRef.value.length === 0) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic ref option)`,
      });
      continue;
    }
    const reference = resolvedRef.value;

    const exactInstance = trigger?.eventFilters?.instance;
    const instancePattern = trigger?.eventFilterPathPatterns?.instance;
    let instance: string;
    if (exactInstance !== undefined) {
      const resolvedInstance = resolveStringOption(exactInstance, env);
      if (!resolvedInstance.ok || resolvedInstance.value.length === 0) {
        unsupported.push({
          exportName,
          eventType: `${eventType} (unsupported dynamic instance option)`,
        });
        continue;
      }
      instance = resolvedInstance.value;
    } else if (instancePattern !== undefined) {
      const resolvedPattern = resolveStringOption(instancePattern, env);
      if (!resolvedPattern.ok || resolvedPattern.value.length === 0) {
        unsupported.push({
          exportName,
          eventType: `${eventType} (unsupported dynamic instance option)`,
        });
        continue;
      }
      if (resolvedPattern.value !== '*') {
        const patternReason = resolvedPattern.containsSecret
          ? 'unsupported instance pattern'
          : `unsupported instance pattern: ${resolvedPattern.value}`;
        unsupported.push({
          exportName,
          eventType: `${eventType} (${patternReason})`,
        });
        continue;
      }
      instance = '*';
    } else {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic instance option)`,
      });
      continue;
    }

    if (!supportsRtdbReference(reference)) {
      const refReason = resolvedRef.containsSecret
        ? 'unsupported ref pattern'
        : `unsupported ref pattern: ${reference}`;
      unsupported.push({
        exportName,
        eventType: `${eventType} (${refReason})`,
      });
      continue;
    }

    const parsedRegion = resolveEndpointRegionsOption(endpoint?.region, DEFAULT_REGION, env);
    if (!parsedRegion.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic region option)`,
      });
      continue;
    }

    if (!resolveBooleanOption(trigger?.retry, env).ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic retry option)`,
      });
      continue;
    }

    if (!resolveTimeoutSecondsOption(endpoint?.timeoutSeconds, env, { allowZero: true }).ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic timeoutSeconds option)`,
      });
      continue;
    }

    const discovered: DiscoveredRtdbValueTrigger = {
      eventType,
      exportName,
      reference: normalizeRtdbReference(reference),
      instance,
      callable,
    };
    if (parsedRegion.location !== undefined) {
      discovered.location = parsedRegion.location;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Classify all v2 RTDB value trigger exports (`created`, `updated`, `deleted`, `written`). */
export function inspectRtdbValueTriggers(
  exported: Record<string, unknown>,
  options: InspectRtdbTriggersOptions = {},
): RtdbValueTriggerInspection {
  return inspectWithAllowedEventTypes(exported, ALL_RTDB_VALUE_EVENT_TYPE_SET, options);
}

export function discoverRtdbValueTriggers(
  exported: Record<string, unknown>,
  options: InspectRtdbTriggersOptions = {},
): DiscoveredRtdbValueTrigger[] {
  return inspectRtdbValueTriggers(exported, options).triggers;
}

/** Classify unchanged v2 RTDB create exports against the single-event `onValueCreated` seam. */
export function inspectOnValueCreated(
  exported: Record<string, unknown>,
  options: InspectRtdbTriggersOptions = {},
): OnValueCreatedInspection {
  const inspected = inspectWithAllowedEventTypes(exported, CREATED_ONLY_EVENT_TYPE_SET, options);
  const triggers: DiscoveredOnValueCreated[] = inspected.triggers.map((trigger) => {
    const out: DiscoveredOnValueCreated = {
      exportName: trigger.exportName,
      reference: trigger.reference,
      instance: trigger.instance,
      callable: trigger.callable,
    };
    if (trigger.location !== undefined) {
      out.location = trigger.location;
    }
    return out;
  });
  return { triggers, unsupported: inspected.unsupported };
}

export function discoverOnValueCreated(
  exported: Record<string, unknown>,
  options: InspectRtdbTriggersOptions = {},
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported, options).triggers;
}

/** The RTDB create family: claims `onValueCreated` endpoints only. */
export const rtdbCreatedFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => endpoint.eventTrigger?.eventType === CREATED_EVENT_TYPE,
  unsupported: (exported, env) =>
    inspectOnValueCreated(exported, env === undefined ? {} : { env }).unsupported,
};

/** Full v2 RTDB value trigger family: claims `created`, `updated`, `deleted`, and `written`. */
export const rtdbValueTriggerFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => isRtdbValueEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported, env) =>
    inspectRtdbValueTriggers(exported, env === undefined ? {} : { env }).unsupported,
};
