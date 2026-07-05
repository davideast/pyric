/**
 * Download + delete operations: `getBytes`, `getBlob`,
 * `deleteObject`.
 *
 * Rules are evaluated via `enforceRules`; denials surface as a
 * `StorageError` with `.code === 'storage/unauthorized'`. The other
 * failure modes — all `StorageError`-shaped now (ST-B1) — are:
 *
 *   - `storage/object-not-found` when no entry exists at the
 *     reference's `fullPath`.
 *   - `storage/invalid-root-operation` when `fullPath` is empty —
 *     matches Firebase's pre-flight on root refs.
 *   - `storage/quota-exceeded` when the persisted blob is larger
 *     than the optional `maxDownloadSizeBytes` cap. (Prod uses
 *     `storage/invalid-argument` for the client-side cap; the
 *     sandbox keeps the descriptive `quota-exceeded` code — see
 *     COMPAT row 55.)
 */
import * as fb from 'firebase/storage';
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import { getStorageService, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored } from './rules.js';
import { objectNotFound, quotaExceeded, invalidRootOperation } from './errors.js';
import { fbRefOf, type StorageReference } from './reference.js';

/**
 * Read the blob at `ref` and return its contents as an
 * `ArrayBuffer`. Honors the optional `maxDownloadSizeBytes` cap.
 */
export async function getBytes(
  ref: StorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  guardNonRoot(ref, 'getBytes');
  const target = targetOf(ref.storage);
  if (target.kind === 'prod') {
    return fb.getBytes(fbRefOf(ref), maxDownloadSizeBytes);
  }
  const blob = await fetchBlob(ref, maxDownloadSizeBytes);
  return blob.arrayBuffer();
}

/**
 * Read the blob at `ref` and return it as a `Blob`. Same semantics
 * as `getBytes` but skips the `arrayBuffer()` conversion when the
 * caller wants a `Blob` directly (e.g. for streaming or
 * `URL.createObjectURL`). Note: this is the browser-side
 * counterpart of the JS SDK's `getBlob` — the v1 scope doesn't ship
 * a Node-stream variant.
 */
export async function getBlob(
  ref: StorageReference,
  maxDownloadSizeBytes?: number,
): Promise<Blob> {
  guardNonRoot(ref, 'getBlob');
  const target = targetOf(ref.storage);
  if (target.kind === 'prod') {
    return fb.getBlob(fbRefOf(ref), maxDownloadSizeBytes);
  }
  return fetchBlob(ref, maxDownloadSizeBytes);
}

/**
 * Delete the object at `ref` — removes both the blob and the
 * metadata atomically. No-op when the path doesn't exist (the
 * persistence layer's `delete` is no-op on missing keys).
 *
 * NOTE: the JS SDK's `deleteObject` throws
 * `storage/object-not-found` when the path is missing. The v1 scope
 * keeps the persistence-layer no-op behavior for now; Slice 8 will
 * reconsider whether to mirror the strict throw.
 */
export async function deleteObject(ref: StorageReference): Promise<void> {
  guardNonRoot(ref, 'deleteObject');
  const target = targetOf(ref.storage);
  if (target.kind === 'prod') {
    await fb.deleteObject(fbRefOf(ref));
    return;
  }
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      method: 'write',
      path: ref.fullPath,
    },
    resource: resourceFromStored(existing),
  });
  await service.backend.delete(ref.fullPath);
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        service: 'storage',
        op: 'object_delete',
        path: ref.fullPath,
        auth: target.context.auth,
        before: existing ?? undefined,
        detail: { bucket: ref.bucket },
      }),
      { service: 'storage' },
    );
  } catch {
    // Observational — never let event emission break a storage delete.
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

async function fetchBlob(
  ref: StorageReference,
  maxDownloadSizeBytes: number | undefined,
): Promise<Blob> {
  const target = targetOf(ref.storage);
  // Prod is handled at the caller (early-return) — this helper is
  // sandbox-only after the dual-target refactor.
  if (target.kind !== 'sandbox') {
    throw new Error('fetchBlob: sandbox-only helper called with prod target');
  }
  const service = await getStorageService(ref.storage);
  // Rule check uses the existing object's metadata (when present)
  // as `resource`. `unauthorized` supersedes `not-found`: the rule
  // check runs FIRST, so an unauthorized read of a missing path
  // reports `unauthorized`, not `not-found`. This matches prod — the
  // server won't disclose object existence to a caller that lacks
  // read permission.
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      method: 'read',
      path: ref.fullPath,
    },
    resource: resourceFromStored(existing),
  });
  const blob = await service.backend.getBlob(ref.fullPath);
  if (!blob) {
    throw objectNotFound(ref.fullPath);
  }
  if (
    typeof maxDownloadSizeBytes === 'number' &&
    blob.size > maxDownloadSizeBytes
  ) {
    throw quotaExceeded(ref.fullPath, blob.size, maxDownloadSizeBytes);
  }
  return blob;
}

function guardNonRoot(ref: StorageReference, op: string): void {
  if (ref.fullPath === '') {
    throw invalidRootOperation(op);
  }
}
