/**
 * Discovery and bucket-target classification for `firebase-functions/v2/storage`
 * Cloud Storage object triggers (`google.cloud.storage.object.v1.*`).
 */
import {
  classifyEndpointOmit,
  isResetValueObject,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';

export const FINALIZED_EVENT_TYPE = 'google.cloud.storage.object.v1.finalized';
export const DELETED_EVENT_TYPE = 'google.cloud.storage.object.v1.deleted';
export const ARCHIVED_EVENT_TYPE = 'google.cloud.storage.object.v1.archived';
export const METADATA_UPDATED_EVENT_TYPE = 'google.cloud.storage.object.v1.metadataUpdated';

export const STORAGE_EVENT_TYPES = [
  FINALIZED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  ARCHIVED_EVENT_TYPE,
  METADATA_UPDATED_EVENT_TYPE,
] as const;

export type StorageEventType = (typeof STORAGE_EVENT_TYPES)[number];

/**
 * Event types wired for runtime execution across `firebase-functions/v2/storage`:
 * `finalized`, `deleted`, `archived`, and `metadataUpdated`.
 */
export const ACTIVE_STORAGE_EVENT_TYPES: ReadonlySet<StorageEventType> = new Set(
  STORAGE_EVENT_TYPES,
);

const STORAGE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(STORAGE_EVENT_TYPES);
const DEFAULT_SANDBOX_STORE_BUCKET = 'pyric-default';

type StorageTriggerCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DiscoveredStorageTrigger {
  exportName: string;
  eventType: StorageEventType;
  bucket?: string;
  targetsDefaultBucket: boolean;
  location?: string;
  callable: StorageTriggerCallable;
}

interface UnsupportedStorageTrigger {
  exportName: string;
  eventType: string;
}

export interface StorageTriggerInspection {
  triggers: DiscoveredStorageTrigger[];
  unsupported: UnsupportedStorageTrigger[];
}

export interface InspectStorageTriggersOptions {
  defaultBucket?: string;
  activeEventTypes?: ReadonlySet<StorageEventType>;
}

export function isStorageEventType(value: unknown): value is StorageEventType {
  return typeof value === 'string' && STORAGE_EVENT_TYPE_SET.has(value);
}

function defaultBucketFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const rawConfig = env.FIREBASE_CONFIG;
  if (typeof rawConfig !== 'string' || rawConfig.length === 0) return undefined;
  if (!rawConfig.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as { storageBucket?: unknown };
    if (typeof parsed.storageBucket === 'string' && parsed.storageBucket.length > 0) {
      return parsed.storageBucket;
    }
  } catch {
    // Ignore malformed FIREBASE_CONFIG JSON during static discovery.
  }
  return undefined;
}

function parseEndpointLocation(
  region: unknown,
): { ok: true; location?: string } | { ok: false } {
  if (region === undefined || region === null || isResetValueObject(region)) {
    return { ok: true };
  }
  if (typeof region === 'string') {
    if (region.length === 0) return { ok: false };
    return { ok: true, location: region };
  }
  if (Array.isArray(region)) {
    if (region.length === 0) return { ok: true };
    const allStrings = region.every((item) => typeof item === 'string' && item.length > 0);
    if (!allStrings) return { ok: false };
    const first = region[0];
    if (typeof first === 'string') {
      return { ok: true, location: first };
    }
    return { ok: true };
  }
  return { ok: false };
}

/**
 * Inspect exported functions for `firebase-functions/v2/storage` triggers,
 * classifying omitted, dynamic-expression, or not-yet-activated triggers.
 */
export function inspectStorageTriggers(
  exported: Record<string, unknown>,
  options: InspectStorageTriggersOptions = {},
): StorageTriggerInspection {
  const effectiveDefaultBucket = options.defaultBucket ?? defaultBucketFromEnv();
  const triggers: DiscoveredStorageTrigger[] = [];
  const unsupported: UnsupportedStorageTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<StorageTriggerCallable>(exported)) {
    const endpoint = callable.__endpoint;
    const eventType = endpoint?.eventTrigger?.eventType;
    if (!isStorageEventType(eventType)) continue;

    const omitState = classifyEndpointOmit(endpoint?.omit);
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

    const rawBucket = endpoint?.eventTrigger?.eventFilters?.bucket;
    if (rawBucket !== undefined && (typeof rawBucket !== 'string' || rawBucket.length === 0)) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic bucket option)`,
      });
      continue;
    }

    const parsedRegion = parseEndpointLocation(endpoint?.region);
    if (!parsedRegion.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic region option)`,
      });
      continue;
    }

    if (options.activeEventTypes !== undefined && !options.activeEventTypes.has(eventType)) {
      unsupported.push({
        exportName,
        eventType,
      });
      continue;
    }

    const bucket = typeof rawBucket === 'string' ? rawBucket : undefined;
    const targetsDefaultBucket =
      bucket === undefined ||
      bucket === DEFAULT_SANDBOX_STORE_BUCKET ||
      (effectiveDefaultBucket !== undefined && bucket === effectiveDefaultBucket);

    const discovered: DiscoveredStorageTrigger = {
      exportName,
      eventType,
      targetsDefaultBucket,
      callable,
    };
    if (bucket !== undefined) {
      discovered.bucket = bucket;
    }
    if (parsedRegion.location !== undefined) {
      discovered.location = parsedRegion.location;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Discover active Storage triggers ready for runtime execution. */
export function discoverStorageTriggers(
  exported: Record<string, unknown>,
  options: InspectStorageTriggersOptions = {},
): DiscoveredStorageTrigger[] {
  const activeEventTypes = options.activeEventTypes ?? ACTIVE_STORAGE_EVENT_TYPES;
  const inspectionOptions: InspectStorageTriggersOptions = { activeEventTypes };
  if (options.defaultBucket !== undefined) {
    inspectionOptions.defaultBucket = options.defaultBucket;
  }
  return inspectStorageTriggers(exported, inspectionOptions).triggers;
}

/** Whether a Storage mutation on `candidate` targets `trigger`'s bucket filter. */
export function matchesStorageTriggerBucket(
  trigger: DiscoveredStorageTrigger,
  candidate: {
    storeBucket: string;
    bucketName: string;
    defaultBucket?: string;
  },
): boolean {
  const isDefaultStore = candidate.storeBucket === DEFAULT_SANDBOX_STORE_BUCKET;
  if (isDefaultStore) {
    if (trigger.targetsDefaultBucket) return true;
    if (trigger.bucket === candidate.bucketName) return true;
    if (candidate.defaultBucket !== undefined && trigger.bucket === candidate.defaultBucket) {
      return true;
    }
    return false;
  }
  if (trigger.targetsDefaultBucket) return false;
  return trigger.bucket === candidate.storeBucket || trigger.bucket === candidate.bucketName;
}

/** The v2 Cloud Storage object trigger family (`google.cloud.storage.object.v1.*`). */
export const storageTriggersFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) => isStorageEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported: Record<string, unknown>) =>
    inspectStorageTriggers(exported, { activeEventTypes: ACTIVE_STORAGE_EVENT_TYPES }).unsupported,
};
