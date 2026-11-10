/**
 * Cloud Storage step execution and multi-bucket resolution for `ProbeWorld`.
 *
 * Isolates each world's IndexedDB backing store via a unique `dbName`, resolves
 * default and named (`gs://bucket` or `bucket`) handles on demand per actor,
 * and executes upload, download (`getBytes` + `getDownloadURL`), prefix list
 * (`listAll`), metadata update (`updateMetadata`), and delete (`deleteObject`)
 * operations against `pyric/storage`.
 */
import type { LocalSandbox, SandboxContext } from 'pyric/sandbox';
import { DEFAULT_SNAPSHOT_RESOURCE, decodeBase64ToBytes } from 'pyric/sandbox/internal';
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  getMetadata,
  getStorageSandbox,
  listAll,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  DEFAULT_BUCKET,
  getAdminStorageSandbox,
  seedStorageObject,
} from 'pyric/storage/internal';
import { lowerModularRulesInMemory } from '../rules/rules-ast-utils.js';
import type { ProbeStep } from './types.js';

export type WorldStorageRules = string | Readonly<Record<string, string>>;

const GS_BUCKET_RE = /^gs:\/\/([^/]+)\/?$/;
const MAX_SYNTHETIC_UPLOAD_BYTES = 64 * 1024 * 1024;

let nextWorldStorageSequence = 1;

export function nextProbeWorldStorageDbName(): string {
  const suffix = `${nextWorldStorageSequence++}-${Math.random().toString(36).slice(2, 10)}`;
  return `pyric-probe-world:${suffix}`;
}

/** Normalize a Storage `resourceId` or `gs://` URL into a named bucket key, or `undefined` for the default bucket. */
export function normalizeStorageBucketKey(resourceId: string | undefined): string | undefined {
  if (resourceId === undefined) return undefined;
  const trimmed = resourceId.trim();
  if (
    trimmed.length === 0
    || trimmed === DEFAULT_SNAPSHOT_RESOURCE
    || trimmed === DEFAULT_BUCKET
  ) {
    return undefined;
  }
  const gsMatch = GS_BUCKET_RE.exec(trimmed);
  let bucket = trimmed.replace(/\/+$/, '');
  if (gsMatch && gsMatch[1]) {
    bucket = gsMatch[1];
  }
  if (
    bucket.length === 0
    || bucket === DEFAULT_SNAPSHOT_RESOURCE
    || bucket === DEFAULT_BUCKET
  ) {
    return undefined;
  }
  return bucket;
}

function defineOwnRule(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function populateWorldStorageRules(
  target: Record<string, string>,
  input: WorldStorageRules | undefined,
): void {
  for (const [existingKey, existingSource] of Object.entries(target)) {
    if (typeof existingSource === 'string') {
      defineOwnRule(
        target,
        existingKey,
        lowerModularRulesInMemory(existingSource, { targetService: 'firebase.storage' }),
      );
    }
  }
  if (input === undefined) return;
  if (typeof input === 'string') {
    defineOwnRule(
      target,
      DEFAULT_SNAPSHOT_RESOURCE,
      lowerModularRulesInMemory(input, { targetService: 'firebase.storage' }),
    );
    return;
  }
  for (const [rawKey, source] of Object.entries(input)) {
    if (typeof source !== 'string') continue;
    const lowered = lowerModularRulesInMemory(source, { targetService: 'firebase.storage' });
    const normalized = normalizeStorageBucketKey(rawKey);
    if (normalized === undefined) {
      defineOwnRule(target, DEFAULT_SNAPSHOT_RESOURCE, lowered);
    } else {
      defineOwnRule(target, normalized, lowered);
    }
  }
}

function adminStorageForBucket(sandbox: LocalSandbox, bucketKey: string | undefined): FirebaseStorage {
  if (bucketKey === undefined) return getAdminStorageSandbox(sandbox);
  return getAdminStorageSandbox(sandbox, { bucket: bucketKey });
}

function actorStorageForStep(
  sandbox: LocalSandbox,
  actorContexts: ReadonlyMap<string, SandboxContext>,
  hasStorage: boolean,
  step: ProbeStep,
): FirebaseStorage {
  if (!hasStorage) {
    throw new Error('no Cloud Storage rules in this world');
  }
  const bucketKey = normalizeStorageBucketKey(step.resourceId);
  if (step.actor === 'admin') {
    return adminStorageForBucket(sandbox, bucketKey);
  }
  const ctx = actorContexts.get(step.actor);
  if (!ctx) {
    throw new Error(`unknown probe actor: ${step.actor}`);
  }
  if (bucketKey === undefined) return getStorageSandbox(ctx);
  return getStorageSandbox(ctx, { bucket: bucketKey });
}

function rawBytesOfData(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data !== null && typeof data === 'object' && Object.hasOwn(data, 'contentBase64')) {
    const base64 = (data as { contentBase64?: unknown }).contentBase64;
    if (typeof base64 === 'string') return decodeBase64ToBytes(base64);
  }
  if (data === undefined || data === null) return new Uint8Array(0);
  return new TextEncoder().encode(JSON.stringify(data));
}

export function toStorageBytes(data: unknown, sizeBytes?: number): Uint8Array {
  const raw = rawBytesOfData(data);
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return raw;
  }
  const targetLength = Math.min(Math.trunc(sizeBytes), MAX_SYNTHETIC_UPLOAD_BYTES);
  if (raw.byteLength === targetLength) return raw;
  if (raw.byteLength > targetLength) return raw.subarray(0, targetLength);
  const sized = new Uint8Array(targetLength);
  sized.set(raw, 0);
  return sized;
}

export function toStorageMetadata(step: ProbeStep): {
  contentType?: string;
  customMetadata?: Record<string, string>;
} {
  const metadata: { contentType?: string; customMetadata?: Record<string, string> } = {};
  if (step.contentType !== undefined) metadata.contentType = step.contentType;
  if (step.customMetadata !== undefined) {
    metadata.customMetadata = { ...step.customMetadata };
  }
  return metadata;
}

export async function executeWorldStorageStep(
  sandbox: LocalSandbox,
  actorContexts: ReadonlyMap<string, SandboxContext>,
  hasStorage: boolean,
  step: ProbeStep,
): Promise<void> {
  const storage = actorStorageForStep(sandbox, actorContexts, hasStorage, step);
  const bucketKey = normalizeStorageBucketKey(step.resourceId);
  const adminStorage = adminStorageForBucket(sandbox, bucketKey);
  const cleanPath = step.path.replace(/^\/+/, '');
  const objectRef = storageRef(storage, cleanPath);
  const metadata = toStorageMetadata(step);

  if (step.method === 'delete' || step.method === 'remove') {
    await deleteObject(objectRef);
    return;
  }

  if (step.method === 'update') {
    if (step.merge && metadata.customMetadata !== undefined) {
      try {
        const current = await getMetadata(storageRef(adminStorage, cleanPath));
        if (current.customMetadata !== undefined) {
          metadata.customMetadata = { ...current.customMetadata, ...metadata.customMetadata };
        }
      } catch {
        // Object may not exist; let updateMetadata enforce rules and surface the error.
      }
    }
    await updateMetadata(objectRef, metadata);
    return;
  }

  if (step.method === 'get') {
    try {
      await getBytes(objectRef);
      await getDownloadURL(objectRef);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'storage/object-not-found') return;
      throw error;
    }
    return;
  }

  if (step.method === 'list') {
    await listAll(objectRef);
    return;
  }

  const bytes = toStorageBytes(step.data, step.sizeBytes);
  if (step.actor === 'admin') {
    await seedStorageObject(adminStorage, cleanPath, bytes, metadata);
    return;
  }
  await uploadBytes(objectRef, bytes, metadata);
}
