/**
 * Download + delete operations: `getBytes`, `getBlob`,
 * `getDownloadURL`, `deleteObject`.
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
 *     than the optional `maxDownloadSizeBytes` cap. The sandbox keeps
 *     the descriptive `quota-exceeded` code — see COMPAT row 55.
 */
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { getStorageService, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored } from './rules.js';
import { objectNotFound, quotaExceeded, invalidRootOperation } from './errors.js';
import type { StorageReference } from './reference.js';

/**
 * Read the blob at `ref` and return its contents as an
 * `ArrayBuffer`. Honors the optional `maxDownloadSizeBytes` cap.
 */
export async function getBytes(
  ref: StorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  guardNonRoot(ref, 'getBytes');
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
  return fetchBlob(ref, maxDownloadSizeBytes);
}

/**
 * Return a URL the current page can use to read the sandbox object. The URL is
 * created from the same rules-checked blob as {@link getBlob}. It is a
 * snapshot, cannot be shared outside the page, and stays
 * alive until the caller revokes it or the page unloads.
 */
export async function getDownloadURL(ref: StorageReference): Promise<string> {
  guardNonRoot(ref, 'getDownloadURL');
  return URL.createObjectURL(await fetchBlob(ref, undefined));
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
 *
 * `provenance` (host-only): op {@link EventProvenance} bound at ISSUE time,
 * threaded EXPLICITLY onto the emitted `object_delete` event. The delete
 * awaits the backend before emitting, so it escapes the sandbox's
 * synchronous ambient-provenance window — see the note on `uploadBytes`.
 */
export async function deleteObject(
  ref: StorageReference,
  provenance?: EventProvenance,
): Promise<void> {
  guardNonRoot(ref, 'deleteObject');
  const target = targetOf(ref.storage);
  const operationProvenance = storageOperationProvenance(target, provenance);
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      method: 'delete',
      path: ref.fullPath,
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
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
      operationProvenance,
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
  const operationProvenance = storageOperationProvenance(target);
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
      method: 'get',
      path: ref.fullPath,
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
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
