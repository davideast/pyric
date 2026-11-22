/**
 * `pyric/firestore` -- `FirestoreSettings` normalization, equivalence checks,
 * and per-app `initializeFirestore` precondition guards.
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { clearHandleCacheTier, hasHandleCacheTier, setHandleCacheTier } from './cache-index-manager.js';
import {
  DEFAULT_CACHE_SIZE_BYTES,
  readLocalCacheSpec,
  type LocalCache,
  type NormalizedLocalCacheSpec,
} from './cache-tokens.js';

const DEFAULT_HOST = 'firestore.googleapis.com';

export interface FirestoreSettings {
  localCache?: LocalCache;
  cacheSizeBytes?: number;
  ignoreUndefinedProperties?: boolean;
  experimentalForceLongPolling?: boolean;
  experimentalAutoDetectLongPolling?: boolean;
  host?: string;
  ssl?: boolean;
}

interface NormalizedFirestoreSettings {
  host: string;
  ssl: boolean;
  ignoreUndefinedProperties: boolean;
  experimentalForceLongPolling: boolean;
  experimentalAutoDetectLongPolling: boolean;
  cacheSizeBytes: number;
  localCache: NormalizedLocalCacheSpec;
}

const appSettingsByDb = new WeakMap<object, Map<string, NormalizedFirestoreSettings>>();
const appSharedHandles = new WeakMap<object, Set<object>>();
const defaultSlotLockedHandles = new WeakSet<object>();

function normalizeDbKey(databaseId: string | undefined): string {
  if (typeof databaseId === 'string' && databaseId.length > 0) return databaseId;
  return '(default)';
}

function isDefaultDatabaseSlot(databaseId: string | undefined): boolean {
  return normalizeDbKey(databaseId) === '(default)';
}

function defaultLocalCacheSpec(tier: 'default' | 'memory' | 'persistent' = 'default'): NormalizedLocalCacheSpec {
  return {
    tier,
    gcMode: 'lru',
    gcCacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
    tabMode: 'single',
    forceOwnership: false,
    cacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
  };
}

function resolveLocalCacheSpec(localCache: LocalCache | undefined): NormalizedLocalCacheSpec {
  if (localCache === undefined || typeof localCache !== 'object' || localCache === null) {
    return defaultLocalCacheSpec();
  }
  const recorded = readLocalCacheSpec(localCache);
  if (recorded !== undefined) return recorded;
  if (localCache.kind === 'persistent') return defaultLocalCacheSpec('persistent');
  if (localCache.kind === 'memory') return defaultLocalCacheSpec('memory');
  return defaultLocalCacheSpec();
}

function normalizeSettings(settings: FirestoreSettings | undefined): NormalizedFirestoreSettings {
  const normalized: NormalizedFirestoreSettings = {
    host: DEFAULT_HOST,
    ssl: true,
    ignoreUndefinedProperties: false,
    experimentalForceLongPolling: false,
    experimentalAutoDetectLongPolling: false,
    cacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
    localCache: defaultLocalCacheSpec(),
  };
  if (settings === undefined || typeof settings !== 'object' || settings === null) {
    return normalized;
  }
  if (typeof settings.host === 'string') normalized.host = settings.host;
  if (typeof settings.ssl === 'boolean') normalized.ssl = settings.ssl;
  normalized.ignoreUndefinedProperties = settings.ignoreUndefinedProperties === true;
  normalized.experimentalForceLongPolling = settings.experimentalForceLongPolling === true;
  normalized.experimentalAutoDetectLongPolling = settings.experimentalAutoDetectLongPolling === true;
  if (typeof settings.cacheSizeBytes === 'number') normalized.cacheSizeBytes = settings.cacheSizeBytes;
  normalized.localCache = resolveLocalCacheSpec(settings.localCache);
  return normalized;
}

function areSettingsEqual(left: NormalizedFirestoreSettings, right: NormalizedFirestoreSettings): boolean {
  const lcLeft = left.localCache;
  const lcRight = right.localCache;
  return (
    left.host === right.host &&
    left.ssl === right.ssl &&
    left.ignoreUndefinedProperties === right.ignoreUndefinedProperties &&
    left.experimentalForceLongPolling === right.experimentalForceLongPolling &&
    left.experimentalAutoDetectLongPolling === right.experimentalAutoDetectLongPolling &&
    left.cacheSizeBytes === right.cacheSizeBytes &&
    lcLeft.tier === lcRight.tier &&
    lcLeft.gcMode === lcRight.gcMode &&
    lcLeft.gcCacheSizeBytes === lcRight.gcCacheSizeBytes &&
    lcLeft.tabMode === lcRight.tabMode &&
    lcLeft.forceOwnership === lcRight.forceOwnership &&
    lcLeft.cacheSizeBytes === lcRight.cacheSizeBytes
  );
}

function settingsMapForApp(app: object): Map<string, NormalizedFirestoreSettings> {
  const existing = appSettingsByDb.get(app);
  if (existing !== undefined) return existing;
  const created = new Map<string, NormalizedFirestoreSettings>();
  appSettingsByDb.set(app, created);
  return created;
}

function registerAppHandle(app: object, handle: object, databaseId?: string): void {
  let handles = appSharedHandles.get(app);
  if (handles === undefined) {
    handles = new Set<object>();
    appSharedHandles.set(app, handles);
  }
  handles.add(handle);
  if (isDefaultDatabaseSlot(databaseId) && !defaultSlotLockedHandles.has(handle)) {
    defaultSlotLockedHandles.add(handle);
    setHandleCacheTier(handle, 'memory');
  }
}

export function recordImplicitAppFirestoreSettings(app: object, databaseId?: string, handle?: object): void {
  const map = settingsMapForApp(app);
  const key = normalizeDbKey(databaseId);
  if (!map.has(key)) map.set(key, normalizeSettings(undefined));
  if (handle !== undefined) registerAppHandle(app, handle, databaseId);
}

export function assertAndRecordAppFirestoreSettings(
  app: object,
  settings: FirestoreSettings | undefined,
  databaseId?: string,
): void {
  const map = settingsMapForApp(app);
  const key = normalizeDbKey(databaseId);
  const incoming = normalizeSettings(settings);
  const existing = map.get(key);
  if (existing !== undefined && !areSettingsEqual(existing, incoming)) {
    throw new FirebaseError(
      'failed-precondition',
      'Firestore has already been started and its settings can no longer be changed. ' +
        'You can only call initializeFirestore() before calling any other functions on a Firestore object.',
    );
  }
  if (existing === undefined) map.set(key, incoming);
}

export function clearAppFirestoreSettings(app: object): void {
  appSettingsByDb.delete(app);
  const handles = appSharedHandles.get(app);
  if (handles === undefined) return;
  for (const handle of handles) {
    defaultSlotLockedHandles.delete(handle);
    clearHandleCacheTier(handle);
  }
  appSharedHandles.delete(app);
}

export function clearAppFirestoreDatabaseSettings(
  app: object,
  databaseId?: string,
  handle?: object,
): void {
  const map = appSettingsByDb.get(app);
  if (map !== undefined) {
    map.delete(normalizeDbKey(databaseId));
    if (map.size === 0) {
      appSettingsByDb.delete(app);
    }
  }
  if (handle !== undefined) {
    defaultSlotLockedHandles.delete(handle);
    clearHandleCacheTier(handle);
    const handles = appSharedHandles.get(app);
    if (handles !== undefined) {
      handles.delete(handle);
      if (handles.size === 0) {
        appSharedHandles.delete(app);
      }
    }
  }
}

export function applySettingsCacheMode(
  handle: object,
  settings: FirestoreSettings | undefined,
  databaseId?: string,
  ownerApp?: object,
): void {
  const normalized = normalizeSettings(settings);
  let tier: 'memory' | 'persistent' = 'memory';
  if (normalized.localCache.tier === 'persistent') tier = 'persistent';
  if (ownerApp === undefined) {
    setHandleCacheTier(handle, tier);
    return;
  }
  registerAppHandle(ownerApp, handle, databaseId);
  if (isDefaultDatabaseSlot(databaseId)) {
    defaultSlotLockedHandles.add(handle);
    setHandleCacheTier(handle, tier);
    return;
  }
  if (!defaultSlotLockedHandles.has(handle) && !hasHandleCacheTier(handle)) {
    setHandleCacheTier(handle, tier);
  }
}
