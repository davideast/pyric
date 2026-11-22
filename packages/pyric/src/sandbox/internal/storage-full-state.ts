/**
 * Multi-bucket Cloud Storage state and rules capture/restore for `FullSandboxState`.
 *
 * Browser-clean (`AGENTS.md` Boundary #5): uses only Web-standard APIs so
 * identical code runs in server and browser/SharedWorker runtimes.
 */
import {
  ref,
  uploadBytes,
  type FirebaseStorage,
} from '../../storage/index.js';
import {
  DEFAULT_BUCKET,
  base64ToBytes,
  deployStorageBucketRules,
  getAdminStorageSandbox,
  getDefaultStorageRulesResolution,
  getStorageCrossServiceIam,
  getStorageService,
  lockUndeployedStorageBuckets,
  pruneStorageBucketRules,
  referenceStorageState,
  replaceCrossServiceIam,
  replaceStorageRules,
  resetStorageState,
  restoreStorageReferences,
  restoreStorageState,
  rulesBucketName,
  snapshotStorageState,
  storageBucketsWithRules,
  type StorageStateRecord,
} from '../../storage/internal.js';
import type { LocalSandbox, Sandbox } from '../types/service.js';
import {
  assertInlineStorageFits,
  base64DecodedLength,
  type InlineStorageDocument,
} from './inline-storage-limit.js';

/**
 * One Storage object, with everything a reader of it can observe. Its bytes are
 * either inline as base64, or named by SHA-256 in the backend that holds them:
 * a capture by reference writes the second form, and only a backend that keeps
 * content-addressed files can apply it.
 */
export type StorageObjectState = {
  /** Non-default bucket holding the object; omitted for the default bucket (`pyric-default`). */
  bucket?: string;
  /** Full path within the bucket, for example `docs/hello.txt`. */
  path: string;
  /** Content type the object reports, absent when it carries none. */
  contentType?: string;
  /** The object's custom metadata. Always present, empty when it carries none. */
  customMetadata: Record<string, string>;
  /** Remaining persisted metadata; absent in legacy states that only kept upload fields. */
  metadata?: Omit<StorageStateRecord['metadata'], 'fullPath' | 'contentType' | 'customMetadata'>;
  /** The stored Blob's MIME type, which can differ from its object metadata. */
  blobType?: string;
} & (
  | {
    /** The object's bytes, base64 encoded so the state stays JSON. */
    contentBase64: string;
  }
  | {
    /** The SHA-256 of the object's bytes, which the backend holds. */
    sha256: string;
    /** The number of bytes. */
    size: number;
  }
);

export interface CapturedStorageRules {
  storage: string | null;
  storageBuckets?: Record<string, string>;
  storageUndeployedPolicy?: 'allow' | 'deny';
  storageCrossServiceIam?: 'granted' | 'denied';
}

const STORAGE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

type StorageService = Awaited<ReturnType<typeof getStorageService>>;

interface StorageRuntimeCachesView {
  readonly openServices: WeakMap<Sandbox, { readonly service: Promise<StorageService>; readonly rulesSource: string | null }>;
  readonly scopedServices: WeakMap<Sandbox, Map<string, Promise<StorageService>>>;
  readonly bucketRules?: WeakMap<Sandbox, Map<string, { readonly source: string }>>;
  readonly defaultStoreNames?: WeakMap<Sandbox, string>;
  readonly undeployedPolicies?: WeakMap<Sandbox, 'allow' | 'deny'>;
}

function readRuntimeStorageCaches(): StorageRuntimeCachesView | undefined {
  const holder = globalThis as { [STORAGE_CACHES_KEY]?: StorageRuntimeCachesView };
  return holder[STORAGE_CACHES_KEY];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function setOwnString(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Normalize an optional object bucket field; returns `undefined` for the default bucket. */
export function normalizeObjectBucket(bucket: string | undefined): string | undefined {
  if (bucket === undefined || bucket === '' || bucket === DEFAULT_BUCKET) {
    return undefined;
  }
  const normalized = rulesBucketName(bucket, bucket);
  if (normalized === DEFAULT_BUCKET) {
    return undefined;
  }
  return normalized;
}

/** Whether a Storage entry carries its bytes inline. */
export function holdsBytesInline(object: StorageObjectState): object is StorageObjectState & { contentBase64: string } {
  return 'contentBase64' in object;
}

/** Where an inline capture's Storage ends up, and what to use past its limit. */
const INLINE_CAPTURE_DOCUMENT: InlineStorageDocument = {
  document: 'An inline state capture, which forks, branch files, and in-process checkpoints are written from,',
  instead: 'Branches carry their Storage bytes inline in every sandbox, so delete or shrink objects until the total ' +
    'fits before forking. On the Node host (`pyric sandbox --hosted`), checkpoints and `pyric snapshot` refer to ' +
    'object bytes by hash and are not bound by this limit.',
};

/** The object bytes a set of Storage entries carries inline, counted without decoding them. */
export function inlineStorageBytes(objects: readonly StorageObjectState[]): number {
  let total = 0;
  for (const object of objects) {
    if (holdsBytesInline(object)) {
      total += base64DecodedLength(object.contentBase64);
    }
  }
  return total;
}

/** Pure read of unnamed default Storage rules, per-bucket rules, undeployed policy, and cross-service IAM. */
export function captureStorageRulesState(sandbox: LocalSandbox): CapturedStorageRules {
  const caches = readRuntimeStorageCaches();
  const storage = getDefaultStorageRulesResolution(sandbox)?.source ?? null;
  const crossServiceIam = getStorageCrossServiceIam(sandbox);

  const storageBuckets: Record<string, string> = {};
  let bucketRuleCount = 0;
  const deployedNames = [...storageBucketsWithRules(sandbox)].sort(compareText);
  for (const bucketName of deployedNames) {
    const deployedSource = caches?.bucketRules?.get(sandbox)?.get(bucketName)?.source;
    if (deployedSource === undefined) continue;
    setOwnString(storageBuckets, bucketName, deployedSource);
    bucketRuleCount += 1;
  }

  const hasPerBucketMode = caches?.bucketRules?.has(sandbox) === true;
  let storageUndeployedPolicy: 'allow' | 'deny' | undefined;
  if (hasPerBucketMode) {
    const policy = caches?.undeployedPolicies?.get(sandbox) ?? 'deny';
    if (bucketRuleCount === 0 || policy === 'allow') {
      storageUndeployedPolicy = policy;
    }
  }

  const captured: CapturedStorageRules = { storage };
  if (bucketRuleCount > 0) {
    captured.storageBuckets = storageBuckets;
  }
  if (storageUndeployedPolicy !== undefined) {
    captured.storageUndeployedPolicy = storageUndeployedPolicy;
  }
  if (crossServiceIam === 'denied') {
    captured.storageCrossServiceIam = 'denied';
  }
  return captured;
}

function orderedStorageBuckets(sandbox: LocalSandbox): string[] {
  const caches = readRuntimeStorageCaches();
  const named = new Set<string>();
  for (const scopedKey of caches?.scopedServices.get(sandbox)?.keys() ?? []) {
    const normalized = normalizeObjectBucket(scopedKey);
    if (normalized !== undefined) named.add(normalized);
  }
  for (const ruleBucket of storageBucketsWithRules(sandbox)) {
    const normalized = normalizeObjectBucket(ruleBucket);
    if (normalized !== undefined) named.add(normalized);
  }
  return [DEFAULT_BUCKET, ...[...named].sort(compareText)];
}

function handleForBucket(
  sandbox: LocalSandbox,
  defaultHandle: FirebaseStorage,
  rawBucket: string,
): FirebaseStorage {
  if (rawBucket === DEFAULT_BUCKET) {
    return defaultHandle;
  }
  return getAdminStorageSandbox(sandbox, { bucket: rawBucket });
}

/** Read every Storage object across the default and named buckets, inline or by reference. */
export async function captureStorageObjects(
  sandbox: LocalSandbox,
  mode: 'inline' | 'reference',
): Promise<StorageObjectState[]> {
  const defaultHandle = getAdminStorageSandbox(sandbox);
  const buckets = orderedStorageBuckets(sandbox);
  if (mode === 'reference') {
    const referenced: StorageObjectState[] = [];
    for (const rawBucket of buckets) {
      const handle = handleForBucket(sandbox, defaultHandle, rawBucket);
      const records = await referenceStorageState(handle);
      records.sort((left, right) => compareText(left.metadata.fullPath, right.metadata.fullPath));
      const objectBucket = normalizeObjectBucket(rawBucket);
      for (const record of records) {
        const { fullPath, contentType, customMetadata, ...metadata } = record.metadata;
        const object: StorageObjectState = {
          path: fullPath,
          sha256: record.sha256,
          size: record.size,
          customMetadata: customMetadata !== undefined ? { ...customMetadata } : {},
          metadata: structuredClone(metadata),
          blobType: record.blobType,
        };
        if (objectBucket !== undefined) object.bucket = objectBucket;
        if (contentType !== undefined) object.contentType = contentType;
        referenced.push(object);
      }
    }
    return referenced;
  }

  let listedTotal = 0;
  for (const rawBucket of buckets) {
    const service = await getStorageService(handleForBucket(sandbox, defaultHandle, rawBucket));
    for (const listed of await service.backend.listByPrefix('')) {
      listedTotal += listed.size;
    }
  }
  assertInlineStorageFits(listedTotal, INLINE_CAPTURE_DOCUMENT);

  const objects: StorageObjectState[] = [];
  for (const rawBucket of buckets) {
    const handle = handleForBucket(sandbox, defaultHandle, rawBucket);
    const records = await snapshotStorageState(handle);
    records.sort((left, right) => compareText(left.metadata.fullPath, right.metadata.fullPath));
    const objectBucket = normalizeObjectBucket(rawBucket);
    for (const record of records) {
      const { fullPath, contentType, customMetadata, ...metadata } = record.metadata;
      const object: StorageObjectState = {
        path: fullPath,
        contentBase64: record.dataBase64,
        customMetadata: customMetadata !== undefined ? { ...customMetadata } : {},
        metadata: structuredClone(metadata),
        blobType: record.blobType,
      };
      if (objectBucket !== undefined) object.bucket = objectBucket;
      if (contentType !== undefined) object.contentType = contentType;
      objects.push(object);
    }
  }
  assertInlineStorageFits(inlineStorageBytes(objects), INLINE_CAPTURE_DOCUMENT);
  return objects;
}

/** Replace every bucket's objects on `sandbox` with exactly the ones `objects` carries. */
export async function applyStorageObjects(
  sandbox: LocalSandbox,
  objects: readonly StorageObjectState[],
): Promise<void> {
  const defaultHandle = getAdminStorageSandbox(sandbox);
  const caches = readRuntimeStorageCaches();
  const openEntry = caches?.openServices.get(sandbox);
  if (openEntry !== undefined) {
    const rootService = await openEntry.service;
    await rootService.backend.reset();
  }
  for (const scopedKey of caches?.scopedServices.get(sandbox)?.keys() ?? []) {
    if (scopedKey === DEFAULT_BUCKET) continue;
    await resetStorageState(getAdminStorageSandbox(sandbox, { bucket: scopedKey }));
  }
  await resetStorageState(defaultHandle);

  for (const object of objects) {
    const bucketName = normalizeObjectBucket(object.bucket);
    const targetBucket = bucketName ?? DEFAULT_BUCKET;
    const handle = handleForBucket(sandbox, defaultHandle, targetBucket);
    const metadata = object.metadata;
    const referenced = !holdsBytesInline(object);
    if (referenced) {
      if (metadata === undefined) {
        throw new Error(`Storage object '${object.path}' is a reference without its metadata.`);
      }
      await restoreStorageReferences(handle, [{
        sha256: object.sha256,
        size: object.size,
        blobType: object.blobType ?? object.contentType ?? '',
        metadata: {
          ...metadata,
          bucket: targetBucket,
          fullPath: object.path,
          contentType: object.contentType,
          customMetadata: { ...object.customMetadata },
        },
      }]);
      continue;
    }
    if (metadata !== undefined) {
      await restoreStorageState(handle, [{
        dataBase64: object.contentBase64,
        blobType: object.blobType ?? object.contentType ?? '',
        metadata: {
          ...metadata,
          bucket: targetBucket,
          fullPath: object.path,
          contentType: object.contentType,
          customMetadata: { ...object.customMetadata },
        },
      }]);
      continue;
    }
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {
      customMetadata: { ...object.customMetadata },
    };
    if (object.contentType !== undefined) {
      settable.contentType = object.contentType;
    }
    await uploadBytes(ref(handle, object.path), base64ToBytes(object.contentBase64), settable);
  }
}

/** Replace the sandbox's default and per-bucket Storage rules, undeployed policy, and cross-service IAM. */
export async function applyStorageRulesState(
  sandbox: LocalSandbox,
  rules: CapturedStorageRules,
): Promise<void> {
  const bucketEntries = Object.entries(rules.storageBuckets ?? {}).sort(([left], [right]) =>
    compareText(left, right),
  );
  const keepBuckets = new Set<string>();
  for (const [bucketName] of bucketEntries) {
    keepBuckets.add(bucketName);
  }
  pruneStorageBucketRules(sandbox, keepBuckets);
  readRuntimeStorageCaches()?.defaultStoreNames?.delete(sandbox);

  await replaceStorageRules(sandbox, rules.storage);
  for (const [bucketName, source] of bucketEntries) {
    deployStorageBucketRules(sandbox, bucketName, source);
  }
  const hasPerBucketRules = bucketEntries.length > 0 || rules.storageUndeployedPolicy !== undefined;
  if (hasPerBucketRules) {
    lockUndeployedStorageBuckets(sandbox, rules.storageUndeployedPolicy ?? 'deny');
  }
  const nextCrossServiceIam = rules.storageCrossServiceIam ?? 'granted';
  if (nextCrossServiceIam !== getStorageCrossServiceIam(sandbox)) {
    await replaceCrossServiceIam(sandbox, nextCrossServiceIam);
  }
}
