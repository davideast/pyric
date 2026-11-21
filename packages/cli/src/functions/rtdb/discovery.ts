import { listFirebaseEndpoints, type FirebaseEndpoint } from '../endpoints.js';
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

function isRtdbValueEventType(value: unknown): value is RtdbValueEventType {
  return typeof value === 'string' && ALL_RTDB_VALUE_EVENT_TYPE_SET.has(value);
}

function inspectWithAllowedEventTypes(
  exported: Record<string, unknown>,
  allowedEventTypes: ReadonlySet<string>,
): RtdbValueTriggerInspection {
  const triggers: DiscoveredRtdbValueTrigger[] = [];
  const unsupported: UnsupportedOnValueCreated[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<RtdbValueCallable>(exported)) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    const eventType = trigger?.eventType;
    if (!isRtdbValueEventType(eventType) || !allowedEventTypes.has(eventType)) {
      continue;
    }
    if (endpoint?.omit === true) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (omitted from emulation)`,
      });
      continue;
    }
    if (endpoint?.omit !== undefined && endpoint.omit !== false) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic omit option)`,
      });
      continue;
    }
    const reference = trigger?.eventFilterPathPatterns?.ref;
    const exactInstance = trigger?.eventFilters?.instance;
    const instancePattern = trigger?.eventFilterPathPatterns?.instance;
    if (typeof reference !== 'string') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic ref option)`,
      });
      continue;
    }
    const hasInvalidExactInstance =
      exactInstance !== undefined && typeof exactInstance !== 'string';
    const hasInvalidWildcardInstance =
      typeof exactInstance !== 'string' && instancePattern !== '*';
    if (hasInvalidExactInstance || hasInvalidWildcardInstance) {
      if (typeof instancePattern === 'string' && instancePattern !== '*') {
        unsupported.push({
          exportName,
          eventType: `${eventType} (unsupported instance pattern: ${instancePattern})`,
        });
      } else {
        unsupported.push({
          exportName,
          eventType: `${eventType} (unsupported dynamic instance option)`,
        });
      }
      continue;
    }
    let instance = '*';
    if (typeof exactInstance === 'string') {
      instance = exactInstance;
    }
    if (!supportsRtdbReference(reference)) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported ref pattern: ${reference})`,
      });
      continue;
    }
    const region = endpoint?.region;
    let location: string | undefined;
    if (Array.isArray(region) && typeof region[0] === 'string') {
      location = region[0];
    }
    const discovered: DiscoveredRtdbValueTrigger = {
      eventType,
      exportName,
      reference: normalizeRtdbReference(reference),
      instance,
      callable,
    };
    if (location !== undefined) {
      discovered.location = location;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Classify all v2 RTDB value trigger exports (`created`, `updated`, `deleted`, `written`). */
export function inspectRtdbValueTriggers(
  exported: Record<string, unknown>,
): RtdbValueTriggerInspection {
  return inspectWithAllowedEventTypes(exported, ALL_RTDB_VALUE_EVENT_TYPE_SET);
}

export function discoverRtdbValueTriggers(
  exported: Record<string, unknown>,
): DiscoveredRtdbValueTrigger[] {
  return inspectRtdbValueTriggers(exported).triggers;
}

/** Classify unchanged v2 RTDB create exports against the single-event `onValueCreated` seam. */
export function inspectOnValueCreated(
  exported: Record<string, unknown>,
): OnValueCreatedInspection {
  const inspected = inspectWithAllowedEventTypes(exported, CREATED_ONLY_EVENT_TYPE_SET);
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
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported).triggers;
}

/** The RTDB create family: claims `onValueCreated` endpoints only. */
export const rtdbCreatedFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => endpoint.eventTrigger?.eventType === CREATED_EVENT_TYPE,
  unsupported: (exported) => inspectOnValueCreated(exported).unsupported,
};

/** Full v2 RTDB value trigger family: claims `created`, `updated`, `deleted`, and `written`. */
export const rtdbValueTriggerFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => isRtdbValueEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported) => inspectRtdbValueTriggers(exported).unsupported,
};
