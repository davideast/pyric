/**
 * Studio's read-only observed Storage mirror for Live mode (`#2542`).
 *
 * Summarizes observed buckets from a validated `ObservedSessionDataSnapshot`
 * (never fabricating phantom `.firebasestorage.app` tabs before Storage traffic
 * arrives) and exposes a `StorageApi` backed exclusively by bounded in-memory
 * metadata and folder prefixes — retaining zero raw object byte buffers and
 * refusing every write or byte read (`PYRIC_LIVE_REFUSED`).
 */
import { selectPreferredStorageBucket } from '@pyric/cli/bridge/client';
import type {
  ObservedSessionDataSnapshot,
  ObservedStorageBucketSnapshot,
  ObservedStorageObjectMetadata,
} from '@pyric/cli/vite/internal/supplied-rows';
import type { StorageApi } from '@pyric/ui/storage';
import type { FirebaseStorage, FullMetadata, ListResult, StorageReference } from 'pyric/storage';
import { createLiveRefusedError } from './observed-session-mirror.js';

export type { ObservedStorageBucketSnapshot, ObservedStorageObjectMetadata };

export interface ObservedStorageBucketSummary {
  readonly bucket: string;
  readonly observed: boolean;
  readonly isDefault: boolean;
  readonly objectCount: number;
  readonly prefixCount: number;
  readonly deletedCount: number;
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

function effectiveProjectId(snapshotProjectId: string, fallbackProjectId?: string): string {
  if (snapshotProjectId.length > 0) return snapshotProjectId;
  if (fallbackProjectId !== undefined && fallbackProjectId.length > 0) return fallbackProjectId;
  return '';
}

function resolveBucketOrFallback(candidate: string, fallback: string): string {
  if (candidate.length > 0) return candidate;
  return fallback;
}

function resolveDefaultObservedBucket(
  snapshot: ObservedSessionDataSnapshot,
  names: readonly string[],
  fallbackProjectId?: string,
): string | null {
  if (
    typeof snapshot.defaultStorageBucket === 'string' &&
    names.includes(snapshot.defaultStorageBucket)
  ) {
    return snapshot.defaultStorageBucket;
  }
  const proj = effectiveProjectId(snapshot.projectId, fallbackProjectId);
  return selectPreferredStorageBucket(names, proj);
}

export function summarizeObservedStorageBuckets(
  snapshot: ObservedSessionDataSnapshot,
  fallbackProjectId?: string,
): readonly ObservedStorageBucketSummary[] {
  const buckets = snapshot.storage;
  if (!buckets) return [];
  const names = Object.keys(buckets);
  if (names.length === 0) return [];
  const defaultBucket = resolveDefaultObservedBucket(snapshot, names, fallbackProjectId);
  const sortedNames = [...names].sort((a, b) => {
    if (a === defaultBucket && b !== defaultBucket) return -1;
    if (b === defaultBucket && a !== defaultBucket) return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  return sortedNames.map((bucket) => {
    const entry = buckets[bucket]!;
    return {
      bucket,
      observed: true,
      isDefault: bucket === defaultBucket,
      objectCount: Object.keys(entry.objects).length,
      prefixCount: entry.prefixes.length,
      deletedCount: entry.deleted?.length ?? 0,
    };
  });
}

export function selectActiveStorageBucket(
  summaries: readonly ObservedStorageBucketSummary[],
  selectedBucket: string | null,
): string {
  if (selectedBucket !== null && selectedBucket.length > 0) {
    const matchingSelected = summaries.find((item) => item.bucket === selectedBucket);
    if (matchingSelected !== undefined) return matchingSelected.bucket;
  }
  const defaultObserved = summaries.find((item) => item.isDefault && item.observed);
  if (defaultObserved !== undefined) return defaultObserved.bucket;
  const firstObserved = summaries.find((item) => item.observed);
  if (firstObserved !== undefined) return firstObserved.bucket;
  if (summaries.length > 0) return summaries[0]!.bucket;
  return '';
}

/** Lightweight token handle whose identity changes with `(bucket, revision)` so UI hooks re-read. */
export function createObservedStorageHandle(bucket: string, revision: number): FirebaseStorage {
  return {
    app: { name: '[LIVE]', options: { storageBucket: bucket } },
    maxOperationRetryTime: 0,
    maxUploadRetryTime: 0,
    _liveBucket: bucket,
    _liveRevision: revision,
  } as unknown as FirebaseStorage;
}

/** Raw observed metadata record for `fullPath` in `catalog`, or `undefined` when absent. */
export function observedObjectOf(
  catalog: ObservedStorageBucketSnapshot | undefined,
  fullPath: string,
): ObservedStorageObjectMetadata | undefined {
  if (!catalog) return undefined;
  return catalog.objects[normalizePath(fullPath)];
}

function createStorageReference(
  storage: FirebaseStorage,
  bucket: string,
  path: string,
): StorageReference {
  const fullPath = normalizePath(path);
  const name = lastSegment(fullPath);
  const reference: {
    bucket: string;
    fullPath: string;
    name: string;
    storage: FirebaseStorage;
    parent: StorageReference | null;
    root: StorageReference;
    toString: () => string;
  } = {
    bucket,
    fullPath,
    name,
    storage,
    parent: null,
    root: null as unknown as StorageReference,
    toString: () => {
      if (fullPath.length > 0) return `gs://${bucket}/${fullPath}`;
      return `gs://${bucket}`;
    },
  };
  if (fullPath.length === 0) {
    reference.root = reference as unknown as StorageReference;
  } else {
    const slashIdx = fullPath.lastIndexOf('/');
    let parentPath = '';
    if (slashIdx !== -1) parentPath = fullPath.slice(0, slashIdx);
    reference.parent = createStorageReference(storage, bucket, parentPath);
    reference.root = createStorageReference(storage, bucket, '');
  }
  return reference as unknown as StorageReference;
}

function createNotFoundError(fullPath: string): Error {
  const error = new Error(
    `Firebase Storage: Object '${fullPath}' was not observed in this live session. (storage/object-not-found)`,
  ) as Error & { code: string };
  error.code = 'storage/object-not-found';
  return error;
}

function fullMetadataSize(observed: ObservedStorageObjectMetadata): number {
  if (observed.size !== undefined) return observed.size;
  return Number.NaN;
}

function toFullMetadata(observed: ObservedStorageObjectMetadata): FullMetadata {
  const metadata: FullMetadata = {
    bucket: observed.bucket,
    fullPath: observed.fullPath,
    name: observed.name,
    size: fullMetadataSize(observed),
    timeCreated: observed.timeCreated ?? '',
    updated: observed.updated ?? '',
    generation: observed.generation ?? '',
    metageneration: observed.metageneration ?? '',
  };
  if (observed.contentType !== undefined) metadata.contentType = observed.contentType;
  if (observed.cacheControl !== undefined) metadata.cacheControl = observed.cacheControl;
  if (observed.contentDisposition !== undefined) {
    metadata.contentDisposition = observed.contentDisposition;
  }
  if (observed.contentEncoding !== undefined) metadata.contentEncoding = observed.contentEncoding;
  if (observed.contentLanguage !== undefined) metadata.contentLanguage = observed.contentLanguage;
  if (observed.md5Hash !== undefined) metadata.md5Hash = observed.md5Hash;
  if (observed.customMetadata !== undefined) metadata.customMetadata = observed.customMetadata;
  return metadata;
}

export interface ActiveBucketView {
  readonly bucket: string;
  readonly catalog: ObservedStorageBucketSnapshot | undefined;
}

function combineRefPath(base: string, url: string | undefined): string {
  if (!url) return base;
  if (base.length === 0) return url;
  return `${base}/${url}`;
}

function toScanPrefix(targetPrefix: string): string {
  if (targetPrefix.length === 0) return '';
  return `${targetPrefix}/`;
}

export function createReadOnlyStorageApi(getActiveBucket: () => ActiveBucketView): StorageApi {
  const refFn: StorageApi['ref'] = (storageOrRef: FirebaseStorage | StorageReference, url?: string) => {
    const { bucket } = getActiveBucket();
    if ('fullPath' in storageOrRef && typeof storageOrRef.fullPath === 'string') {
      const combined = combineRefPath(storageOrRef.fullPath, url);
      return createStorageReference(
        storageOrRef.storage,
        resolveBucketOrFallback(storageOrRef.bucket, bucket),
        combined,
      );
    }
    return createStorageReference(storageOrRef as FirebaseStorage, bucket, url ?? '');
  };

  const listAllFn: StorageApi['listAll'] = async (targetRef: StorageReference): Promise<ListResult> => {
    const { bucket, catalog } = getActiveBucket();
    if (!catalog) {
      return { items: [], prefixes: [] };
    }
    const targetPrefix = normalizePath(targetRef.fullPath);
    const scanPrefix = toScanPrefix(targetPrefix);
    const childFolderPaths = new Set<string>();
    const childObjectPaths = new Set<string>();

    for (const prefix of catalog.prefixes) {
      const norm = normalizePath(prefix);
      if (norm.length === 0 || norm === targetPrefix || !norm.startsWith(scanPrefix)) continue;
      const relative = norm.slice(scanPrefix.length);
      const firstSeg = relative.split('/')[0];
      if (firstSeg) {
        childFolderPaths.add(`${scanPrefix}${firstSeg}`);
      }
    }

    for (const objectPath of Object.keys(catalog.objects)) {
      const norm = normalizePath(objectPath);
      if (norm.length === 0 || norm === targetPrefix || !norm.startsWith(scanPrefix)) continue;
      const relative = norm.slice(scanPrefix.length);
      const slashIdx = relative.indexOf('/');
      if (slashIdx === -1) {
        childObjectPaths.add(norm);
      } else {
        const firstSeg = relative.slice(0, slashIdx);
        if (firstSeg.length > 0) {
          childFolderPaths.add(`${scanPrefix}${firstSeg}`);
        }
      }
    }

    const activeBucket = resolveBucketOrFallback(targetRef.bucket, bucket);
    const prefixes = Array.from(childFolderPaths)
      .sort()
      .map((folderPath) => createStorageReference(targetRef.storage, activeBucket, folderPath));
    const items = Array.from(childObjectPaths)
      .sort()
      .map((itemPath) => createStorageReference(targetRef.storage, activeBucket, itemPath));
    return { items, prefixes };
  };

  const getMetadataFn: StorageApi['getMetadata'] = async (
    targetRef: StorageReference,
  ): Promise<FullMetadata> => {
    const { catalog } = getActiveBucket();
    const observed = observedObjectOf(catalog, targetRef.fullPath);
    if (!observed) {
      throw createNotFoundError(targetRef.fullPath);
    }
    return toFullMetadata(observed);
  };

  const refuse = () => Promise.reject(createLiveRefusedError());

  return {
    ref: refFn,
    listAll: listAllFn,
    getMetadata: getMetadataFn,
    getBlob: refuse,
    uploadBytes: refuse as unknown as StorageApi['uploadBytes'],
    uploadBytesResumable: (() => {
      throw createLiveRefusedError();
    }) as unknown as StorageApi['uploadBytesResumable'],
    deleteObject: refuse,
  };
}
