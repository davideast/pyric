/**
 * Cross-bucket operational handle resolution for `ref(storage, url)`.
 *
 * Upstream `firebase/storage` keeps `ref(storage, url).storage === storage`
 * while scoping the reference's `Location` to the URL's bucket so reads,
 * writes, listings, metadata updates, deletions, and rules checks address that
 * bucket. `SandboxStorageReference` preserves the public `.storage` handle and
 * carries the bucket-scoped operational handle under `OPERATION_STORAGE_SYMBOL`.
 */
import { rulesBucketName } from '@pyric/rules/internal/storage';
import type { FirebaseApp } from '../../app/types.js';
import { createStorageRetryHandle } from '../handle-retry-times.js';
import { DEFAULT_BUCKET } from '../persistence.js';
import {
  getAdminStorageSandbox,
  getStorageSandbox,
  TARGET_SYMBOL,
  targetOf,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageOptions,
} from '../service.js';
import { parseBucketSpec } from './bucket-spec.js';

export const OPERATION_STORAGE_SYMBOL: unique symbol = Symbol.for(
  'pyric/storage/ref-operation-storage',
) as never;

const SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

interface DefaultStoreNamesCache {
  readonly defaultStoreNames?: WeakMap<object, string>;
}

export interface ReferenceWithOperationStorage {
  readonly storage?: object;
  readonly [OPERATION_STORAGE_SYMBOL]?: FirebaseStorage;
}

export function operationStorageOf(ref: { readonly storage: FirebaseStorage }): FirebaseStorage;
export function operationStorageOf(ref: ReferenceWithOperationStorage): object | undefined;
export function operationStorageOf(
  ref: ReferenceWithOperationStorage,
): FirebaseStorage | object | undefined {
  const scoped = ref[OPERATION_STORAGE_SYMBOL];
  if (scoped !== undefined) {
    return scoped;
  }
  return ref.storage;
}

function pinnedDefaultBucketOf(sandbox: object): string | undefined {
  const caches = (globalThis as { [SERVICE_CACHES_KEY]?: DefaultStoreNamesCache })[
    SERVICE_CACHES_KEY
  ];
  if (caches === undefined) return undefined;
  if (caches.defaultStoreNames === undefined) return undefined;
  return caches.defaultStoreNames.get(sandbox);
}

function appDefaultBucketOf(storage: FirebaseStorage): string | undefined {
  const attachedApp = storage.app;
  if (attachedApp === undefined) return undefined;
  try {
    const rawBucket = attachedApp.options?.storageBucket;
    const hasRawBucket = typeof rawBucket === 'string' && rawBucket !== '';
    if (hasRawBucket) {
      return parseBucketSpec(rawBucket);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function callerBucketNameOfTarget(target: SandboxTarget): string {
  if (target.bucketName === '') return '';
  if (target.bucketName !== undefined) {
    return rulesBucketName(target.bucket, target.bucketName);
  }
  return target.bucket;
}

function addressesSameDefaultBucket(
  storage: FirebaseStorage,
  target: SandboxTarget,
  requestedBucket: string,
): boolean {
  if (requestedBucket === DEFAULT_BUCKET) return true;
  const appDefault = appDefaultBucketOf(storage);
  if (appDefault !== undefined && appDefault !== '') {
    return requestedBucket === appDefault;
  }
  const pinnedDefault = pinnedDefaultBucketOf(target.sandbox);
  if (pinnedDefault !== undefined && pinnedDefault !== '') {
    return requestedBucket === pinnedDefault;
  }
  const onNamedDefault =
    target.bucket === DEFAULT_BUCKET &&
    target.bucketName !== undefined &&
    target.bucketName !== '';
  if (onNamedDefault) {
    const currentDefaultName = rulesBucketName(target.bucket, target.bucketName);
    return requestedBucket === currentDefaultName;
  }
  return false;
}

export function resolveReferenceOperationStorage(
  storage: FirebaseStorage,
  urlBucket: string | undefined,
): FirebaseStorage {
  if (urlBucket === undefined) return storage;
  const target = targetOf(storage);
  const requestedBucket = rulesBucketName(urlBucket, urlBucket);
  const currentBucketName = callerBucketNameOfTarget(target);
  if (requestedBucket === currentBucketName) {
    return storage;
  }

  let storeBucket = requestedBucket;
  const targetsDefaultStore = addressesSameDefaultBucket(storage, target, requestedBucket);
  if (targetsDefaultStore) {
    storeBucket = DEFAULT_BUCKET;
  }

  const options: StorageOptions = {};
  if (storeBucket !== DEFAULT_BUCKET) {
    options.bucket = storeBucket;
  }

  let baseScoped: FirebaseStorage;
  if (target.admin === true) {
    baseScoped = getAdminStorageSandbox(target.context, options);
  } else {
    baseScoped = getStorageSandbox(target.context, options);
  }
  const baseTarget = targetOf(baseScoped);

  const nextTarget: {
    kind: 'sandbox';
    sandbox: SandboxTarget['sandbox'];
    context: SandboxTarget['context'];
    currentAuth?: SandboxTarget['currentAuth'];
    bucket: string;
    bucketName: string;
    servicePromise: SandboxTarget['servicePromise'];
    admin?: boolean;
    caller?: SandboxTarget['caller'];
  } = {
    kind: 'sandbox',
    sandbox: target.sandbox,
    context: target.context,
    bucket: baseTarget.bucket,
    bucketName: requestedBucket,
    servicePromise: baseTarget.servicePromise,
  };
  if (target.currentAuth !== undefined) {
    nextTarget.currentAuth = target.currentAuth;
  }
  if (target.admin !== undefined) {
    nextTarget.admin = target.admin;
  }
  if (target.caller !== undefined) {
    nextTarget.caller = target.caller;
  }

  const handleSeed: { [TARGET_SYMBOL]: SandboxTarget; app?: FirebaseApp } = {
    [TARGET_SYMBOL]: nextTarget,
  };
  if (storage.app !== undefined) {
    handleSeed.app = storage.app;
  }
  return createStorageRetryHandle<FirebaseStorage>(handleSeed, storage);
}
