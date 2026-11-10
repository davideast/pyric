/**
 * Studio-side runtime validator for the optional `storage` section of
 * `GET /__pyric/live/session-data`.
 *
 * Reuses `@pyric/cli/bridge/client`'s shared key hygiene and Firebase/GCS URL
 * origin policy so client SDK capture, CLI host validation, and Studio snapshot
 * parsing enforce one rule set without drift.
 */
import {
  FORBIDDEN_STORAGE_KEYS,
  MAX_STORAGE_METADATA_STRING_CHARS,
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
  copyStorageCustomMetadataRecord,
  validateObservedStorageDownloadUrl,
} from '@pyric/cli/bridge/client';
import type {
  ObservedSessionDataSnapshot,
  ObservedStorageBucketSnapshot,
  ObservedStorageObjectMetadata,
} from '@pyric/cli/vite/internal/supplied-rows';

export interface ParsedObservedStorageSection {
  readonly storage: Record<string, ObservedStorageBucketSnapshot>;
  readonly defaultStorageBucket: string | null;
  readonly storageBuckets: number;
  readonly storageObjects: number;
}

type MutableObservedObjectMetadata = {
  -readonly [K in keyof ObservedStorageObjectMetadata]: ObservedStorageObjectMetadata[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isAllowedKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_STORAGE_KEYS.has(key);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function lastSegment(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) return normalized;
  return normalized.slice(idx + 1);
}

function parseCustomMetadata(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const stringEntries: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isAllowedKey(key) || typeof value !== 'string') continue;
    if (value.length > MAX_STORAGE_METADATA_STRING_CHARS) continue;
    Object.defineProperty(stringEntries, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const copied = copyStorageCustomMetadataRecord(stringEntries);
  if (Object.keys(copied).length === 0) return undefined;
  return copied;
}

function parseObjectMetadata(
  bucket: string,
  keyPath: string,
  raw: unknown,
): ObservedStorageObjectMetadata | undefined {
  if (!isPlainObject(raw)) return undefined;
  let rawPath = keyPath;
  if (typeof raw.fullPath === 'string') rawPath = raw.fullPath;
  const fullPath = normalizePath(rawPath);
  if (fullPath.length === 0 || !isAllowedKey(fullPath)) return undefined;
  let name = lastSegment(fullPath);
  if (typeof raw.name === 'string' && raw.name.length > 0) {
    name = raw.name;
  }

  const meta: MutableObservedObjectMetadata = { bucket, fullPath, name };
  if (isNonNegativeNumber(raw.size)) meta.size = raw.size;
  for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
    const val = raw[field];
    if (typeof val === 'string' && val.length <= MAX_STORAGE_METADATA_STRING_CHARS) {
      meta[field] = val;
    }
  }
  for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
    const val = raw[field];
    if (typeof val === 'string' && val.length <= MAX_STORAGE_METADATA_STRING_CHARS) {
      meta[field] = val;
    }
  }
  const customMetadata = parseCustomMetadata(raw.customMetadata);
  if (customMetadata !== undefined) meta.customMetadata = customMetadata;
  const validatedUrl = validateObservedStorageDownloadUrl(raw.downloadUrl);
  if (validatedUrl !== undefined) meta.downloadUrl = validatedUrl;
  return meta;
}

function parseNormalizedPathList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const normalized = normalizePath(item);
    if (isAllowedKey(normalized)) {
      seen.add(normalized);
    }
  }
  return Array.from(seen).sort();
}

/** Validate the optional `storage` section of a host session-data snapshot. */
export function parseObservedStorageSection(
  rawSnapshot: Record<string, unknown>,
): ParsedObservedStorageSection | undefined {
  if (!isPlainObject(rawSnapshot.storage)) return undefined;
  const storage: Record<string, ObservedStorageBucketSnapshot> = {};
  let totalObjects = 0;

  for (const [bucket, rawBucket] of Object.entries(rawSnapshot.storage)) {
    if (!isAllowedKey(bucket) || !isPlainObject(rawBucket)) continue;
    const prefixes = parseNormalizedPathList(rawBucket.prefixes);
    const deleted = parseNormalizedPathList(rawBucket.deleted);
    const objects: Record<string, ObservedStorageObjectMetadata> = {};
    if (isPlainObject(rawBucket.objects)) {
      for (const [objectKey, rawMeta] of Object.entries(rawBucket.objects)) {
        if (!isAllowedKey(objectKey)) continue;
        const parsed = parseObjectMetadata(bucket, objectKey, rawMeta);
        if (parsed !== undefined) {
          objects[parsed.fullPath] = parsed;
        }
      }
    }
    const bucketSnap: {
      prefixes: readonly string[];
      objects: Record<string, ObservedStorageObjectMetadata>;
      deleted?: readonly string[];
    } = { prefixes, objects };
    if (deleted.length > 0) bucketSnap.deleted = deleted;
    storage[bucket] = bucketSnap;
    totalObjects += Object.keys(objects).length;
  }

  const bucketNames = Object.keys(storage);
  if (bucketNames.length === 0) return undefined;

  let rawStats: Record<string, unknown> = {};
  if (isPlainObject(rawSnapshot.stats)) rawStats = rawSnapshot.stats;
  let storageBuckets = bucketNames.length;
  if (isNonNegativeNumber(rawStats.storageBuckets)) {
    storageBuckets = rawStats.storageBuckets;
  }
  let storageObjects = totalObjects;
  if (isNonNegativeNumber(rawStats.storageObjects)) {
    storageObjects = rawStats.storageObjects;
  }

  let defaultStorageBucket: string | null = bucketNames[0] ?? null;
  if (
    typeof rawSnapshot.defaultStorageBucket === 'string' &&
    rawSnapshot.defaultStorageBucket.length > 0
  ) {
    defaultStorageBucket = rawSnapshot.defaultStorageBucket;
  }

  return {
    storage,
    defaultStorageBucket,
    storageBuckets,
    storageObjects,
  };
}

/** Attach validated Storage catalog fields to a parsed session-data snapshot when present. */
export function withObservedStorageSection(
  base: ObservedSessionDataSnapshot,
  rawSnapshot: Record<string, unknown>,
): ObservedSessionDataSnapshot {
  const parsed = parseObservedStorageSection(rawSnapshot);
  if (parsed === undefined) return base;
  return {
    ...base,
    storage: parsed.storage,
    defaultStorageBucket: parsed.defaultStorageBucket,
    stats: {
      ...base.stats,
      storageBuckets: parsed.storageBuckets,
      storageObjects: parsed.storageObjects,
    },
  };
}
