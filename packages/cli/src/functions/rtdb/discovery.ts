import { listFirebaseEndpoints, type FirebaseEndpoint } from '../endpoints.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';
import {
  normalizeRtdbReference,
  supportsRtdbReference,
} from './reference-pattern.js';

export type RtdbCreatedCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DiscoveredOnValueCreated {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
  callable: RtdbCreatedCallable;
}

export interface UnsupportedOnValueCreated {
  exportName: string;
  eventType: string;
}

export interface OnValueCreatedInspection {
  triggers: DiscoveredOnValueCreated[];
  unsupported: UnsupportedOnValueCreated[];
}

export const CREATED_EVENT_TYPE = 'google.firebase.database.ref.v1.created';

/** Classify unchanged v2 RTDB create exports against the admitted first slice. */
export function inspectOnValueCreated(
  exported: Record<string, unknown>,
): OnValueCreatedInspection {
  const triggers: DiscoveredOnValueCreated[] = [];
  const unsupported: UnsupportedOnValueCreated[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints<RtdbCreatedCallable>(exported)) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    if (trigger?.eventType !== CREATED_EVENT_TYPE) continue;
    if (endpoint?.omit === true) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (omitted from emulation)`,
      });
      continue;
    }
    if (endpoint?.omit !== undefined && endpoint.omit !== false) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (unsupported dynamic omit option)`,
      });
      continue;
    }
    const reference = trigger.eventFilterPathPatterns?.ref;
    const exactInstance = trigger.eventFilters?.instance;
    const instancePattern = trigger.eventFilterPathPatterns?.instance;
    if (typeof reference !== 'string') continue;
    if (typeof exactInstance !== 'string' && instancePattern !== '*') {
      if (typeof instancePattern === 'string') {
        unsupported.push({
          exportName,
          eventType: `${CREATED_EVENT_TYPE} (unsupported instance pattern: ${instancePattern})`,
        });
      }
      continue;
    }
    const instance = typeof exactInstance === 'string' ? exactInstance : '*';
    if (!supportsRtdbReference(reference)) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (unsupported ref pattern: ${reference})`,
      });
      continue;
    }
    const region = endpoint?.region;
    const location = Array.isArray(region) && typeof region[0] === 'string'
      ? region[0]
      : undefined;
    triggers.push({
      exportName,
      reference: normalizeRtdbReference(reference),
      instance,
      ...(location === undefined ? {} : { location }),
      callable,
    });
  }
  return { triggers, unsupported };
}

export function discoverOnValueCreated(
  exported: Record<string, unknown>,
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported).triggers;
}

/** The RTDB create family: it claims every `onValueCreated` endpoint. */
export const rtdbCreatedFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => endpoint.eventTrigger?.eventType === CREATED_EVENT_TYPE,
  unsupported: (exported) => inspectOnValueCreated(exported).unsupported,
};
