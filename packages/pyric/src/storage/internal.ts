/**
 * `pyric/storage/internal` — host-only admin plane for the sandbox
 * storage backend.
 *
 * The public `pyric/storage` surface is deliberately rules-honest:
 * every operation on a handle from `getStorageSandbox` evaluates the
 * configured storage rules against the handle's context identity.
 * Hosts that must serve firebase-admin semantics (the SharedWorker
 * host resolving `actAs: { mode: 'admin' }` storage ops for
 * `pyric-admin`'s remote dispatch arm, Pyric Studio's admin lens)
 * need a rules-BYPASS handle onto the SAME per-sandbox store.
 *
 * This subpath exists so that bypass never leaks onto the public
 * modular surface — mirroring how `pyric/sandbox/internal` carries
 * the sandbox's host-only seams.
 */

import type { Sandbox } from 'pyric/sandbox';
import { getClock } from '../sandbox/clock.js';
import { generationIssuer } from './generation.js';
import { ref } from './reference.js';
import { rulesBucketName } from '@pyric/rules/internal/storage';
import {
  deployStorageBucketRules,
  getStorageService,
  storageBucketsWithRules,
  targetOf,
  type FirebaseStorage,
} from './service.js';
import { buildStoredMetadata } from './upload.js';

export {
  bindStorageOperationContext,
  getAdminStorageSandbox,
  getStorageService,
  nameStorageBucket,
  storageAuth,
  storageOperationProvenance,
  targetOf,
  installStorageBackend,
  getStorageCrossServiceIam,
  getStorageRulesResolution,
  replaceCrossServiceIam,
  replaceStorageRules,
  deployStorageBucketRules,
  lockUndeployedStorageBuckets,
  storageBucketsWithRules,
  compiledStorageRulesForBucket,
} from './service.js';
export {
  enforceRules,
  normalizeRecordedStorageDeniedWrite,
  primeStorageDeniedWrites,
  storageDeniedWrites,
  storageFirestoreLookup,
  type RecordedStorageDeniedWrite,
} from './enforce.js';
export {
  emptyStorageObservation,
  evaluateStorageRules,
  type StorageEvaluationObservation,
} from '@pyric/rules/internal/storage';
export { requestResourceFor, resourceFromStored } from './sandbox/rules-resources.js';
export { bindRulesBucket, rulesBucketName } from '@pyric/rules/internal/storage';
export { clientContentEncoding, uploadContentDisposition } from './content-defaults.js';
export {
  cloneCustomMetadata,
  cloneSettableMetadata,
  patchObjectMetadata,
  toFullMetadata,
  type AdminMetadataPatch,
} from './metadata.js';
export {
  decodeString,
  defaultRawContentType,
  uploadObject,
  uploadObjectReplacing,
  type ReplacingUploadResult,
  type UploadObjectOptions,
} from './upload.js';
export { arrayBufferToBase64, base64ToBytes } from './base64.js';
export { generationIssuer, higherGeneration, raisedMark, type GenerationIssuer } from './generation.js';
export { isStorageUrl, parseStorageUrl, refPathOf, type StorageLocation } from './url.js';
export {
  compileStorageRules,
  type CompiledStorageRules,
  type StorageRulesResolution,
} from '@pyric/rules/internal/storage';
export {
  snapshotStorageState, restoreStorageState, resetStorageState, referenceStorageState, restoreStorageReferences,
  type StorageStateRecord, type StorageReferenceRecord,
} from './sandbox/persistence-state.js';
export { DEFAULT_BUCKET, assertPriorAt, type StorageBackend, type StoredMetadata, type StoredObject } from './persistence.js';
export { copyObject } from './copy.js';
export { deleteObjectGeneration } from './download.js';
export {
  canceledRollbackFailed, keepReplacedObject, restoreObjectGeneration, rollBackCanceledCommit,
  undoCanceledCommit,
  type ReplacedAtCommit, type RollbackOutcome,
} from './upload-rollback.js';
export { fetchFromByteRoute, uploadOverByteRoute, type RemoteByteRoute, type RemoteReadRequest, type RemoteUploadRequest } from './remote-bytes.js';

export { observeStorageOperation, storageTaskProgress, storageTaskResult } from '../sandbox/internal/storage-activity.js';
export { localStorageUrl, storageObjectPath, STORAGE_ROUTE_PREFIX } from './byte-route.js';

const SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

interface MutableStorageBucketRuleCaches {
  bucketRules?: WeakMap<Sandbox, Map<string, unknown>>;
  defaultStoreNames?: WeakMap<Sandbox, string>;
  undeployedPolicies?: WeakMap<Sandbox, string>;
}

/**
 * Remove per-bucket Storage rules not present in `keepBuckets`. When zero
 * named-bucket rules remain on `sandbox`, clears the per-sandbox bucket-rules
 * map entry so undeployed buckets revert to unlocked default rules resolution.
 */
export function pruneStorageBucketRules(
  sandbox: Sandbox,
  keepBuckets: ReadonlySet<string>,
): void {
  const normalizedKeep = new Set<string>();
  for (const bucket of keepBuckets) {
    normalizedKeep.add(rulesBucketName(bucket, bucket));
  }
  for (const deployed of storageBucketsWithRules(sandbox)) {
    if (!normalizedKeep.has(deployed)) {
      deployStorageBucketRules(sandbox, deployed, null);
    }
  }
  if (storageBucketsWithRules(sandbox).length === 0) {
    const holder = globalThis as { [SERVICE_CACHES_KEY]?: MutableStorageBucketRuleCaches };
    const caches = holder[SERVICE_CACHES_KEY];
    caches?.bucketRules?.delete(sandbox);
    caches?.defaultStoreNames?.delete(sandbox);
    caches?.undeployedPolicies?.delete(sandbox);
  }
}

/**
 * Seed an object directly onto `storage`'s backing store without evaluating
 * Storage rules or emitting synthetic SDK operation/mutation history events.
 */
export async function seedStorageObject(
  storage: FirebaseStorage,
  path: string,
  bytes: Uint8Array,
  settable?: {
    readonly contentType?: string;
    readonly customMetadata?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const objectRef = ref(storage, path);
  if (objectRef.fullPath === '') {
    throw new Error('Cannot seed a Storage object at the bucket root.');
  }
  const target = targetOf(storage);
  const uploadedAt = getClock(target.sandbox).date();
  const blob = new Blob([bytes as BlobPart], { type: settable?.contentType ?? '' });
  let customMetadata: Record<string, string> | undefined;
  if (settable?.customMetadata !== undefined) {
    customMetadata = { ...settable.customMetadata };
  }
  const stored = buildStoredMetadata({
    ref: objectRef,
    blob,
    settable: {
      contentType: settable?.contentType,
      customMetadata,
    },
    now: uploadedAt,
  });
  const service = await getStorageService(storage);
  await service.backend.put(
    objectRef.fullPath,
    blob,
    stored,
    generationIssuer(uploadedAt.getTime()),
  );
}
