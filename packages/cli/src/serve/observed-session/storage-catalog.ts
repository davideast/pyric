/**
 * Self-contained, bounded LRU in-memory catalog of observed Cloud Storage
 * object metadata, folder prefixes, and session delete tombstones per bucket
 * (`gs://<bucket>/<fullPath>`).
 *
 * Holds zero raw binary byte buffers: only sanitized metadata fields, listed
 * and inferred folder prefixes, delete tombstones, and credential-stripped
 * Storage URLs. Evicts least-recently-used Storage entries within its own
 * budget so Storage traffic never evicts Firestore documents or RTDB trees.
 */
import { MAX_SINGLE_ITEM_BYTES } from './delta-validation.js';
import { byteLengthOf } from './json-values.js';
import {
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
  sanitizeObservedStorageDownloadUrl,
  scrubStorageCustomMetadataRecord,
  selectPreferredStorageBucket,
  type ObservedStorageBucketSnapshot,
  type ObservedStorageObjectInput,
  type ObservedStorageObjectMetadata,
  type ObservedStorageSessionOp,
} from './storage-policy.js';
import { UNREAD_BUCKET, type ObservedSessionDataSnapshot } from './wire.js';

const DEFAULT_MAX_STORAGE_OBJECTS = 2000;
const DEFAULT_MAX_STORAGE_BUCKETS = 32;
const DEFAULT_MAX_STORAGE_BYTES = 8 * 1024 * 1024;
const MAX_PREFIXES_PER_BUCKET = 2000;
const MAX_TOMBSTONES_PER_BUCKET = 250;

export type StorageCatalogDropReason = 'oversized' | 'truncated' | 'unsupported';

export interface ObservedStorageCatalogOptions {
  readonly maxObjects?: number;
  readonly maxBuckets?: number;
  readonly maxBytes?: number;
  readonly projectId: () => string;
  readonly onDrop: (reason: StorageCatalogDropReason) => void;
}

export interface ObservedStorageCatalog {
  apply(op: ObservedStorageSessionOp): boolean;
  applyAll(ops: readonly ObservedStorageSessionOp[] | undefined): boolean;
  byteEstimate(): number;
  bucketCount(): number;
  objectCount(): number;
  defaultBucket(): string | null;
  snapshot(): Record<string, ObservedStorageBucketSnapshot>;
  withStorageSnapshot(base: ObservedSessionDataSnapshot): ObservedSessionDataSnapshot;
}

type MutableStorageObjectMetadata = {
  -readonly [K in keyof ObservedStorageObjectMetadata]: ObservedStorageObjectMetadata[K];
};

interface StoredObjectEntry {
  meta: ObservedStorageObjectMetadata;
  bytes: number;
}

interface BucketEntry {
  bucketBytes: number;
  explicitPrefixes: Set<string>;
  objects: Map<string, StoredObjectEntry>;
  deleted: Map<string, number>;
}

function objectKey(bucket: string, fullPath: string): string {
  return `${bucket}\u0000${fullPath}`;
}

function lastPathSegment(fullPath: string): string {
  const slash = fullPath.lastIndexOf('/');
  if (slash === -1) return fullPath;
  return fullPath.slice(slash + 1);
}

function parentPrefixOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return '';
  return path.slice(0, slash);
}

function ancestorPrefixesOf(path: string, includeSelf: boolean): string[] {
  const segments = path.split('/').filter((seg) => seg.length > 0);
  let limit = Math.max(0, segments.length - 1);
  if (includeSelf) limit = segments.length;
  const out: string[] = [];
  for (let idx = 1; idx <= limit; idx++) {
    out.push(segments.slice(0, idx).join('/'));
  }
  return out;
}

function matchesPrefixScope(candidate: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function isStrictlyInsidePrefix(candidate: string, prefix: string): boolean {
  if (prefix.length === 0) return candidate.length > 0;
  return candidate.startsWith(`${prefix}/`);
}

function childSegmentUnderPrefix(fullPath: string, prefix: string): string {
  let relative = fullPath;
  if (prefix.length > 0) relative = fullPath.slice(prefix.length + 1);
  const immediateChild = relative.split('/')[0] ?? '';
  if (prefix.length === 0) return immediateChild;
  return `${prefix}/${immediateChild}`;
}

function mergeObjectMetadata(
  bucket: string,
  fullPath: string,
  existing: ObservedStorageObjectMetadata | undefined,
  input: ObservedStorageObjectInput,
  replaceMetadata: boolean,
): ObservedStorageObjectMetadata {
  const next: MutableStorageObjectMetadata = {
    bucket,
    fullPath,
    name: lastPathSegment(fullPath),
  };

  if (!replaceMetadata && existing !== undefined) {
    if (existing.size !== undefined) next.size = existing.size;
    for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
      if (existing[field] !== undefined) next[field] = existing[field];
    }
    for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
      if (existing[field] !== undefined) next[field] = existing[field];
    }
    if (existing.customMetadata !== undefined) {
      next.customMetadata = { ...existing.customMetadata };
    }
  }
  if (existing?.downloadUrl !== undefined) {
    next.downloadUrl = existing.downloadUrl;
  }
  if (input.size !== undefined) {
    next.size = input.size;
  }
  for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
    const val = input[field];
    if (val === null) {
      delete next[field];
    } else if (typeof val === 'string') {
      next[field] = val;
    }
  }
  for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
    const val = input[field];
    if (typeof val === 'string') next[field] = val;
  }
  if (input.customMetadata === null) {
    delete next.customMetadata;
  } else if (input.customMetadata !== undefined) {
    const scrubbed = scrubStorageCustomMetadataRecord(input.customMetadata);
    if (Object.keys(scrubbed).length > 0) {
      next.customMetadata = scrubbed;
    } else {
      delete next.customMetadata;
    }
  }
  return next;
}

export function createObservedStorageCatalog(
  options: ObservedStorageCatalogOptions,
): ObservedStorageCatalog {
  const maxObjects = Math.max(1, options.maxObjects ?? DEFAULT_MAX_STORAGE_OBJECTS);
  const maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULT_MAX_STORAGE_BUCKETS);
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_STORAGE_BYTES);

  const buckets = new Map<string, BucketEntry>();
  const objectOrder = new Map<string, { bucket: string; fullPath: string }>();
  let storageBytes = 0;

  function defaultBucket(): string | null {
    return selectPreferredStorageBucket(buckets.keys(), options.projectId());
  }

  function resolveBucketName(rawBucket: string): string | undefined {
    if (rawBucket !== UNREAD_BUCKET) return rawBucket;
    const knownDefault = defaultBucket();
    if (knownDefault !== null) return knownDefault;
    options.onDrop('unsupported');
    return undefined;
  }

  function touchBucket(bucket: string, entry: BucketEntry): void {
    buckets.delete(bucket);
    buckets.set(bucket, entry);
  }

  function touchObjectKey(bucket: string, fullPath: string): void {
    const key = objectKey(bucket, fullPath);
    if (!objectOrder.has(key)) return;
    objectOrder.delete(key);
    objectOrder.set(key, { bucket, fullPath });
  }

  function deleteEmptyBucketIfIdle(bucket: string): void {
    const entry = buckets.get(bucket);
    if (entry === undefined) return;
    const isIdle =
      entry.objects.size === 0 && entry.explicitPrefixes.size === 0 && entry.deleted.size === 0;
    if (!isIdle) return;
    buckets.delete(bucket);
    storageBytes = Math.max(0, storageBytes - entry.bucketBytes);
  }

  function evictEntireBucket(bucket: string): boolean {
    const entry = buckets.get(bucket);
    if (entry === undefined) return false;
    for (const [fullPath, stored] of entry.objects) {
      objectOrder.delete(objectKey(bucket, fullPath));
      storageBytes = Math.max(0, storageBytes - stored.bytes);
    }
    for (const prefix of entry.explicitPrefixes) {
      storageBytes = Math.max(0, storageBytes - byteLengthOf(prefix));
    }
    for (const bytes of entry.deleted.values()) {
      storageBytes = Math.max(0, storageBytes - bytes);
    }
    buckets.delete(bucket);
    storageBytes = Math.max(0, storageBytes - entry.bucketBytes);
    options.onDrop('truncated');
    return true;
  }

  function removeStoredObject(bucket: string, fullPath: string): StoredObjectEntry | undefined {
    const bucketEntry = buckets.get(bucket);
    const stored = bucketEntry?.objects.get(fullPath);
    if (bucketEntry === undefined || stored === undefined) return undefined;
    bucketEntry.objects.delete(fullPath);
    objectOrder.delete(objectKey(bucket, fullPath));
    storageBytes = Math.max(0, storageBytes - stored.bytes);
    return stored;
  }

  function removeExplicitPrefix(entry: BucketEntry, prefix: string): boolean {
    if (!entry.explicitPrefixes.has(prefix)) return false;
    entry.explicitPrefixes.delete(prefix);
    storageBytes = Math.max(0, storageBytes - byteLengthOf(prefix));
    return true;
  }

  function removeTombstone(entry: BucketEntry, fullPath: string): boolean {
    const bytes = entry.deleted.get(fullPath);
    if (bytes === undefined) return false;
    entry.deleted.delete(fullPath);
    storageBytes = Math.max(0, storageBytes - bytes);
    return true;
  }

  function evictLeastRecentlyUsedObject(): boolean {
    const oldestKey = objectOrder.keys().next().value;
    if (oldestKey === undefined) return false;
    const oldest = objectOrder.get(oldestKey);
    if (oldest === undefined) return false;
    removeStoredObject(oldest.bucket, oldest.fullPath);
    deleteEmptyBucketIfIdle(oldest.bucket);
    options.onDrop('truncated');
    return true;
  }

  function evictLeastRecentlyUsedAuxiliary(): boolean {
    for (const [bucket, entry] of buckets) {
      const oldestDeleted = entry.deleted.keys().next().value;
      if (oldestDeleted !== undefined) {
        removeTombstone(entry, oldestDeleted);
        deleteEmptyBucketIfIdle(bucket);
        options.onDrop('truncated');
        return true;
      }
      const oldestPrefix = entry.explicitPrefixes.values().next().value;
      if (oldestPrefix !== undefined) {
        removeExplicitPrefix(entry, oldestPrefix);
        deleteEmptyBucketIfIdle(bucket);
        options.onDrop('truncated');
        return true;
      }
      return evictEntireBucket(bucket);
    }
    return false;
  }

  function fitStorageBytes(neededBytes: number): boolean {
    if (neededBytes <= 0) return true;
    if (neededBytes > maxBytes) return false;
    while (storageBytes + neededBytes > maxBytes) {
      if (evictLeastRecentlyUsedObject()) continue;
      if (!evictLeastRecentlyUsedAuxiliary()) break;
    }
    return storageBytes + neededBytes <= maxBytes;
  }

  function ensureBucket(bucket: string): BucketEntry | undefined {
    const existing = buckets.get(bucket);
    if (existing !== undefined) {
      touchBucket(bucket, existing);
      return existing;
    }
    while (buckets.size >= maxBuckets) {
      const oldestBucket = buckets.keys().next().value;
      if (oldestBucket === undefined || !evictEntireBucket(oldestBucket)) break;
    }
    if (buckets.size >= maxBuckets) {
      options.onDrop('truncated');
      return undefined;
    }
    const bucketBytes = byteLengthOf(bucket);
    if (!fitStorageBytes(bucketBytes)) {
      options.onDrop('truncated');
      return undefined;
    }
    const created: BucketEntry = {
      bucketBytes,
      explicitPrefixes: new Set(),
      objects: new Map(),
      deleted: new Map(),
    };
    buckets.set(bucket, created);
    storageBytes += bucketBytes;
    return created;
  }

  function addExplicitPrefixChain(entry: BucketEntry, path: string): void {
    for (const prefix of ancestorPrefixesOf(path, true)) {
      if (entry.explicitPrefixes.has(prefix)) {
        entry.explicitPrefixes.delete(prefix);
        entry.explicitPrefixes.add(prefix);
        continue;
      }
      if (entry.explicitPrefixes.size >= MAX_PREFIXES_PER_BUCKET) {
        const oldest = entry.explicitPrefixes.values().next().value;
        if (oldest !== undefined) removeExplicitPrefix(entry, oldest);
        options.onDrop('truncated');
      }
      const bytes = byteLengthOf(prefix);
      if (!fitStorageBytes(bytes)) {
        options.onDrop('truncated');
        return;
      }
      entry.explicitPrefixes.add(prefix);
      storageBytes += bytes;
    }
  }

  function recordTombstone(entry: BucketEntry, fullPath: string): boolean {
    const alreadyTombstoned = entry.deleted.has(fullPath);
    removeTombstone(entry, fullPath);
    if (entry.deleted.size >= MAX_TOMBSTONES_PER_BUCKET) {
      const oldest = entry.deleted.keys().next().value;
      if (oldest !== undefined) removeTombstone(entry, oldest);
    }
    const bytes = byteLengthOf(fullPath);
    if (!fitStorageBytes(bytes)) return !alreadyTombstoned;
    entry.deleted.set(fullPath, bytes);
    storageBytes += bytes;
    return !alreadyTombstoned;
  }

  function resolveWritableBucket(bucket: string): BucketEntry | undefined {
    const found = buckets.get(bucket);
    if (found !== undefined) return found;
    return ensureBucket(bucket);
  }

  function writeObject(
    bucket: string,
    entry: BucketEntry,
    nextMeta: ObservedStorageObjectMetadata,
  ): boolean {
    const bytes = byteLengthOf(nextMeta.fullPath) + byteLengthOf(nextMeta);
    if (bytes > MAX_SINGLE_ITEM_BYTES || bytes > maxBytes) {
      deleteEmptyBucketIfIdle(bucket);
      options.onDrop('oversized');
      return false;
    }
    const hadTombstone = removeTombstone(entry, nextMeta.fullPath);
    const previous = removeStoredObject(bucket, nextMeta.fullPath);
    while (objectOrder.size >= maxObjects) {
      if (!evictLeastRecentlyUsedObject()) break;
    }
    const activeEntry = resolveWritableBucket(bucket);
    if (activeEntry === undefined || objectOrder.size >= maxObjects || !fitStorageBytes(bytes)) {
      deleteEmptyBucketIfIdle(bucket);
      options.onDrop('truncated');
      return previous !== undefined || hadTombstone;
    }
    const finalEntry = resolveWritableBucket(bucket);
    if (finalEntry === undefined) return previous !== undefined || hadTombstone;
    finalEntry.objects.set(nextMeta.fullPath, { meta: nextMeta, bytes });
    objectOrder.set(objectKey(bucket, nextMeta.fullPath), { bucket, fullPath: nextMeta.fullPath });
    storageBytes += bytes;
    return true;
  }

  function pruneAbsentFromCompleteList(
    bucket: string,
    entry: BucketEntry,
    op: Extract<ObservedStorageSessionOp, { kind: 'list' }>,
  ): void {
    const seenItems = new Set(op.items.map((item) => item.fullPath));
    const seenPrefixes = new Set(op.prefixes);

    if (op.recursive === true) {
      for (const fullPath of [...entry.objects.keys()]) {
        if (matchesPrefixScope(fullPath, op.prefix) && !seenItems.has(fullPath)) {
          removeStoredObject(bucket, fullPath);
        }
      }
      for (const pfx of [...entry.explicitPrefixes]) {
        if (isStrictlyInsidePrefix(pfx, op.prefix) && !seenPrefixes.has(pfx)) {
          removeExplicitPrefix(entry, pfx);
        }
      }
      return;
    }

    const absentChildPrefixes = new Set<string>();
    for (const fullPath of [...entry.objects.keys()]) {
      if (!isStrictlyInsidePrefix(fullPath, op.prefix)) continue;
      if (parentPrefixOf(fullPath) === op.prefix) {
        if (!seenItems.has(fullPath)) removeStoredObject(bucket, fullPath);
        continue;
      }
      const childPrefix = childSegmentUnderPrefix(fullPath, op.prefix);
      if (!seenPrefixes.has(childPrefix)) absentChildPrefixes.add(childPrefix);
    }

    for (const pfx of [...entry.explicitPrefixes]) {
      if (isStrictlyInsidePrefix(pfx, op.prefix) && parentPrefixOf(pfx) === op.prefix) {
        if (!seenPrefixes.has(pfx)) absentChildPrefixes.add(pfx);
      }
    }

    for (const absentPrefix of absentChildPrefixes) {
      for (const fullPath of [...entry.objects.keys()]) {
        if (matchesPrefixScope(fullPath, absentPrefix)) removeStoredObject(bucket, fullPath);
      }
      for (const pfx of [...entry.explicitPrefixes]) {
        if (matchesPrefixScope(pfx, absentPrefix)) removeExplicitPrefix(entry, pfx);
      }
    }
  }

  function applyListOp(
    op: Extract<ObservedStorageSessionOp, { kind: 'list' }>,
    bucket: string,
  ): boolean {
    const entry = ensureBucket(bucket);
    if (entry === undefined) return false;
    if (op.prefix.length > 0) addExplicitPrefixChain(entry, op.prefix);
    for (const childPrefix of op.prefixes) {
      addExplicitPrefixChain(entry, childPrefix);
    }
    if (op.complete === true) {
      pruneAbsentFromCompleteList(bucket, entry, op);
    }
    for (const item of op.items) {
      const current = entry.objects.get(item.fullPath)?.meta;
      if (current !== undefined && item.metadata === undefined) {
        removeTombstone(entry, item.fullPath);
        touchObjectKey(bucket, item.fullPath);
        continue;
      }
      const nextMeta = mergeObjectMetadata(bucket, item.fullPath, current, item.metadata ?? {}, false);
      writeObject(bucket, entry, nextMeta);
    }
    return true;
  }

  function applySingle(op: ObservedStorageSessionOp): boolean {
    const bucket = resolveBucketName(op.bucket);
    if (bucket === undefined) return false;
    switch (op.kind) {
    case 'upsert': {
        const entry = ensureBucket(bucket);
        if (entry === undefined) return false;
        const current = entry.objects.get(op.fullPath)?.meta;
        const next = mergeObjectMetadata(bucket, op.fullPath, current, op.metadata, op.replaceMetadata === true);
        return writeObject(bucket, entry, next);
      }
      case 'list':
        return applyListOp(op, bucket);
      case 'downloadUrl': {
        const sanitized = sanitizeObservedStorageDownloadUrl(op.downloadUrl);
        if (sanitized === undefined) {
          options.onDrop('unsupported');
          return false;
        }
        const entry = ensureBucket(bucket);
        if (entry === undefined) return false;
        const base = entry.objects.get(op.fullPath)?.meta ?? {
          bucket,
          fullPath: op.fullPath,
          name: lastPathSegment(op.fullPath),
        };
        return writeObject(bucket, entry, { ...base, downloadUrl: sanitized });
      }
      case 'delete': {
        const entry = ensureBucket(bucket);
        if (entry === undefined) return false;
        const removed = removeStoredObject(bucket, op.fullPath);
        const addedTombstone = recordTombstone(entry, op.fullPath);
        deleteEmptyBucketIfIdle(bucket);
        return removed !== undefined || addedTombstone;
      }
      case 'deletePrefix': {
        const entry = buckets.get(bucket);
        if (entry === undefined) return false;
        touchBucket(bucket, entry);
        let changed = false;
        for (const fullPath of [...entry.objects.keys()]) {
          if (matchesPrefixScope(fullPath, op.prefix) && removeStoredObject(bucket, fullPath) !== undefined) {
            recordTombstone(entry, fullPath);
            changed = true;
          }
        }
        for (const existingPrefix of [...entry.explicitPrefixes]) {
          if (matchesPrefixScope(existingPrefix, op.prefix) && removeExplicitPrefix(entry, existingPrefix)) {
            changed = true;
          }
        }
        deleteEmptyBucketIfIdle(bucket);
        return changed;
      }
    }
  }

  function buildSnapshot(): Record<string, ObservedStorageBucketSnapshot> {
    const out: Record<string, ObservedStorageBucketSnapshot> = {};
    for (const [bucket, entry] of buckets) {
      const objects: Record<string, ObservedStorageObjectMetadata> = {};
      const prefixSet = new Set<string>(entry.explicitPrefixes);
      for (const [fullPath, stored] of entry.objects) {
        objects[fullPath] = structuredClone(stored.meta);
        for (const inferred of ancestorPrefixesOf(fullPath, false)) {
          prefixSet.add(inferred);
        }
      }
      const bucketSnap: {
        prefixes: string[];
        objects: Record<string, ObservedStorageObjectMetadata>;
        deleted?: string[];
      } = { prefixes: [...prefixSet].sort(), objects };
      if (entry.deleted.size > 0) {
        bucketSnap.deleted = [...entry.deleted.keys()].sort();
      }
      out[bucket] = bucketSnap;
    }
    return out;
  }

  return {
    apply: applySingle,
    applyAll(ops) {
      if (ops === undefined || ops.length === 0) return false;
      let changed = false;
      for (const op of ops) {
        if (applySingle(op)) changed = true;
      }
      return changed;
    },
    byteEstimate: () => storageBytes,
    bucketCount: () => buckets.size,
    objectCount: () => objectOrder.size,
    defaultBucket,
    snapshot: buildSnapshot,
    withStorageSnapshot(base) {
      if (buckets.size === 0) return base;
      const stats = { ...base.stats, storageBuckets: buckets.size, storageObjects: objectOrder.size, byteEstimate: base.stats.byteEstimate + storageBytes };
      return { ...base, storage: buildSnapshot(), defaultStorageBucket: defaultBucket(), stats };
    },
  };
}
