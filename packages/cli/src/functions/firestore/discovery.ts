/**
 * Discovery and validation of `firebase-functions/v2/firestore` document trigger
 * exports across all 8 `google.cloud.firestore.document.v1.*` event types.
 */
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
  normalizeFirestoreDocumentPath,
  supportsFirestoreDocumentPattern,
} from './document-pattern.js';

export const DOCUMENT_CREATED_EVENT = 'google.cloud.firestore.document.v1.created';
export const DOCUMENT_UPDATED_EVENT = 'google.cloud.firestore.document.v1.updated';
export const DOCUMENT_DELETED_EVENT = 'google.cloud.firestore.document.v1.deleted';
export const DOCUMENT_WRITTEN_EVENT = 'google.cloud.firestore.document.v1.written';
export const DOCUMENT_CREATED_WITH_AUTH_EVENT =
  'google.cloud.firestore.document.v1.created.withAuthContext';
export const DOCUMENT_UPDATED_WITH_AUTH_EVENT =
  'google.cloud.firestore.document.v1.updated.withAuthContext';
export const DOCUMENT_DELETED_WITH_AUTH_EVENT =
  'google.cloud.firestore.document.v1.deleted.withAuthContext';
export const DOCUMENT_WRITTEN_WITH_AUTH_EVENT =
  'google.cloud.firestore.document.v1.written.withAuthContext';

export const FIRESTORE_EVENT_TYPES = [
  DOCUMENT_CREATED_EVENT,
  DOCUMENT_UPDATED_EVENT,
  DOCUMENT_DELETED_EVENT,
  DOCUMENT_WRITTEN_EVENT,
  DOCUMENT_CREATED_WITH_AUTH_EVENT,
  DOCUMENT_UPDATED_WITH_AUTH_EVENT,
  DOCUMENT_DELETED_WITH_AUTH_EVENT,
  DOCUMENT_WRITTEN_WITH_AUTH_EVENT,
] as const;

export type FirestoreTriggerEventType = (typeof FIRESTORE_EVENT_TYPES)[number];
export type FirestoreTriggerOperation = 'created' | 'updated' | 'deleted' | 'written';

export const DEFAULT_FIRESTORE_DATABASE = '(default)';
export const DEFAULT_FIRESTORE_NAMESPACE = '(default)';

const FIRESTORE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(FIRESTORE_EVENT_TYPES);

/** All 8 Firestore v2 document trigger event types wired for runtime execution. */
export const ACTIVE_FIRESTORE_EVENT_TYPES: ReadonlySet<FirestoreTriggerEventType> = new Set(
  FIRESTORE_EVENT_TYPES,
);

type FirestoreTriggerCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DiscoveredFirestoreTrigger {
  exportName: string;
  eventType: FirestoreTriggerEventType;
  operation: FirestoreTriggerOperation;
  withAuthContext: boolean;
  document: string;
  database: string;
  namespace: string;
  location?: string;
  callable: FirestoreTriggerCallable;
}

interface UnsupportedFirestoreTrigger {
  exportName: string;
  eventType: string;
}

export interface FirestoreTriggerInspection {
  triggers: DiscoveredFirestoreTrigger[];
  unsupported: UnsupportedFirestoreTrigger[];
}

export interface InspectFirestoreTriggersOptions {
  admittedEventTypes?: ReadonlySet<FirestoreTriggerEventType>;
  env?: ParamsEnvMap;
}

/** Whether an Eventarc `eventType` belongs to `firebase-functions/v2/firestore`. */
export function isFirestoreTriggerEventType(
  eventType: unknown,
): eventType is FirestoreTriggerEventType {
  return typeof eventType === 'string' && FIRESTORE_EVENT_TYPE_SET.has(eventType);
}

function classifyOperation(eventType: FirestoreTriggerEventType): {
  operation: FirestoreTriggerOperation;
  withAuthContext: boolean;
} {
  const withAuthContext = eventType.endsWith('.withAuthContext');
  if (
    eventType === DOCUMENT_CREATED_EVENT ||
    eventType === DOCUMENT_CREATED_WITH_AUTH_EVENT
  ) {
    return { operation: 'created', withAuthContext };
  }
  if (
    eventType === DOCUMENT_UPDATED_EVENT ||
    eventType === DOCUMENT_UPDATED_WITH_AUTH_EVENT
  ) {
    return { operation: 'updated', withAuthContext };
  }
  if (
    eventType === DOCUMENT_DELETED_EVENT ||
    eventType === DOCUMENT_DELETED_WITH_AUTH_EVENT
  ) {
    return { operation: 'deleted', withAuthContext };
  }
  return { operation: 'written', withAuthContext };
}

function resolveDocumentFilter(
  eventFilters: Record<string, unknown> | undefined,
  eventFilterPathPatterns: Record<string, unknown> | undefined,
  env: ParamsEnvMap | undefined,
): { ok: true; document: string; containsSecret: boolean } | { ok: false; reason: string } {
  const patternDoc = eventFilterPathPatterns?.document;
  if (patternDoc !== undefined) {
    const resolved = resolveStringOption(patternDoc, env);
    if (resolved.ok && resolved.value.length > 0) {
      return { ok: true, document: resolved.value, containsSecret: resolved.containsSecret };
    }
    return { ok: false, reason: 'unsupported dynamic document option' };
  }
  const literalDoc = eventFilters?.document;
  if (literalDoc !== undefined) {
    const resolved = resolveStringOption(literalDoc, env);
    if (resolved.ok && resolved.value.length > 0) {
      return { ok: true, document: resolved.value, containsSecret: resolved.containsSecret };
    }
  }
  return { ok: false, reason: 'unsupported dynamic document option' };
}

function resolveStringFilter(
  exactValue: unknown,
  patternValue: unknown,
  fallback: string,
  fieldLabel: string,
  env: ParamsEnvMap | undefined,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (patternValue !== undefined) {
    const resolvedPattern = resolveStringOption(patternValue, env);
    if (resolvedPattern.ok) {
      if (resolvedPattern.containsSecret) {
        return { ok: false, reason: `unsupported ${fieldLabel} pattern` };
      }
      return {
        ok: false,
        reason: `unsupported ${fieldLabel} pattern: ${resolvedPattern.value}`,
      };
    }
    return { ok: false, reason: `unsupported dynamic ${fieldLabel} option` };
  }
  if (exactValue === undefined) {
    return { ok: true, value: fallback };
  }
  const resolvedExact = resolveStringOption(exactValue, env);
  if (resolvedExact.ok && resolvedExact.value.length > 0) {
    return { ok: true, value: resolvedExact.value };
  }
  return { ok: false, reason: `unsupported dynamic ${fieldLabel} option` };
}

/**
 * Inspect exported functions and classify all 8 Firestore v2 document triggers.
 * By default (`options.admittedEventTypes` omitted), all 8 event types are admitted.
 */
export function inspectFirestoreTriggers(
  exported: Record<string, unknown>,
  options: InspectFirestoreTriggersOptions = {},
): FirestoreTriggerInspection {
  const triggers: DiscoveredFirestoreTrigger[] = [];
  const unsupported: UnsupportedFirestoreTrigger[] = [];
  const admitted = options.admittedEventTypes;
  const env = options.env;

  for (const { exportName, callable } of listFirebaseEndpoints<FirestoreTriggerCallable>(exported)) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    const eventType = trigger?.eventType;
    if (!isFirestoreTriggerEventType(eventType)) continue;

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
    if (admitted !== undefined && !admitted.has(eventType)) {
      unsupported.push({ exportName, eventType });
      continue;
    }

    const docFilter = resolveDocumentFilter(
      trigger?.eventFilters,
      trigger?.eventFilterPathPatterns,
      env,
    );
    if (!docFilter.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (${docFilter.reason})`,
      });
      continue;
    }

    const databaseFilter = resolveStringFilter(
      trigger?.eventFilters?.database,
      trigger?.eventFilterPathPatterns?.database,
      DEFAULT_FIRESTORE_DATABASE,
      'database',
      env,
    );
    if (!databaseFilter.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (${databaseFilter.reason})`,
      });
      continue;
    }

    const namespaceFilter = resolveStringFilter(
      trigger?.eventFilters?.namespace,
      trigger?.eventFilterPathPatterns?.namespace,
      DEFAULT_FIRESTORE_NAMESPACE,
      'namespace',
      env,
    );
    if (!namespaceFilter.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (${namespaceFilter.reason})`,
      });
      continue;
    }

    if (!supportsFirestoreDocumentPattern(docFilter.document)) {
      const patternReason = docFilter.containsSecret
        ? 'unsupported document pattern'
        : `unsupported document pattern: ${docFilter.document}`;
      unsupported.push({
        exportName,
        eventType: `${eventType} (${patternReason})`,
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

    const { operation, withAuthContext } = classifyOperation(eventType);
    const discovered: DiscoveredFirestoreTrigger = {
      exportName,
      eventType,
      operation,
      withAuthContext,
      document: normalizeFirestoreDocumentPath(docFilter.document),
      database: databaseFilter.value,
      namespace: namespaceFilter.value,
      callable,
    };
    if (parsedRegion.location !== undefined) {
      discovered.location = parsedRegion.location;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Discover valid Firestore triggers admitted for execution. */
export function discoverFirestoreTriggers(
  exported: Record<string, unknown>,
  options: InspectFirestoreTriggersOptions = { admittedEventTypes: ACTIVE_FIRESTORE_EVENT_TYPES },
): DiscoveredFirestoreTrigger[] {
  return inspectFirestoreTriggers(exported, options).triggers;
}

/** Claims all 8 `google.cloud.firestore.document.v1.*` trigger endpoints. */
export const firestoreTriggersFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) =>
    isFirestoreTriggerEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported, env) =>
    inspectFirestoreTriggers(exported, {
      admittedEventTypes: ACTIVE_FIRESTORE_EVENT_TYPES,
      ...(env === undefined ? {} : { env }),
    }).unsupported,
};
