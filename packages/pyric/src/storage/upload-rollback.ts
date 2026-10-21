/**
 * Rolling back a canceled upload's own write (#1161).
 *
 * A resumable upload commits in one call that cannot be recalled, so a cancel
 * that races it waits for the commit and then undoes what it stored. A
 * canceled upload leaves the path as it found it, as the Firebase SDK
 * guarantees, and the task rejects only once that holds.
 *
 * The rollback touches only the generation the canceled commit stored. A
 * later write that replaced it is kept. Production never stores a canceled
 * upload, so its rules never see the rollback, and this module does not
 * evaluate them.
 */
import { emitSandboxEvent, getClock, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { deleteObjectGeneration } from './download.js';
import type { StoredMetadata, StoredObject } from './persistence.js';
import type { StorageReference } from './reference.js';
import { getStorageService, storageAuth, storageOperationProvenance, targetOf } from './service.js';

/**
 * Put `prior` back at `ref` only while the object there is still
 * `generation`. Resolves false, writing nothing, when the object is gone or a
 * later write replaced that generation.
 */
export async function restoreObjectGeneration(
  ref: StorageReference,
  generation: string,
  prior: StoredObject,
  provenance?: EventProvenance,
): Promise<boolean> {
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  const isThatGeneration = existing !== undefined && existing.generation === generation;
  if (!isThatGeneration) return false;
  await service.backend.put(ref.fullPath, prior.blob, prior.metadata);
  emitObjectRestore(ref, existing, prior.metadata, provenance);
  return true;
}

/** Land the restore on the sandbox stream as the `object_put` it is. */
function emitObjectRestore(
  ref: StorageReference,
  replaced: StoredMetadata,
  restored: StoredMetadata,
  provenance: EventProvenance | undefined,
): void {
  const target = targetOf(ref.storage);
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        at: getClock(target.sandbox).now(),
        service: 'storage',
        op: 'object_put',
        path: ref.fullPath,
        auth: storageAuth(target),
        before: replaced,
        after: restored,
        detail: { bucket: ref.bucket, size: restored.size, contentType: restored.contentType, overwrite: true },
      }),
      storageOperationProvenance(target, provenance),
    );
  } catch {
    // Observational: never let event emission break the rollback.
  }
}

/** The object one canceled commit stored, and the one it replaced. */
export interface CanceledCommit {
  readonly generation: string;
  /** The object at the path before the commit, undefined when there was none. */
  readonly prior: StoredObject | undefined;
}

/**
 * Undo a canceled commit: restore the object it replaced, or delete the one
 * it created, in both cases only while its own generation is still there.
 * Resolves the error the cancel ends with when the rollback fails.
 */
export async function rollBackCanceledCommit(
  ref: StorageReference,
  commit: CanceledCommit,
  provenance?: EventProvenance,
): Promise<Error | undefined> {
  const prior = commit.prior;
  if (prior !== undefined) {
    return restoreObjectGeneration(ref, commit.generation, prior, provenance).then(
      () => undefined,
      (cause: unknown) => canceledRollbackFailed(ref.fullPath, cause, 'restore'),
    );
  }
  return deleteObjectGeneration(ref, commit.generation, provenance).then(
    () => undefined,
    (cause: unknown) => canceledRollbackFailed(ref.fullPath, cause, 'remove'),
  );
}

/** What failed, by what the rollback was undoing. */
const UNDO_FAILED = {
  remove: 'removing it failed',
  restore: 'restoring the object it replaced failed',
} as const;

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return undefined;
}

/**
 * The error a cancel ends with when its rollback failed. It carries the
 * rollback's code, not `storage/canceled`, because the object the upload
 * stored is still there, and `storage/canceled` promises it is not. The
 * worker client builds the same error.
 */
export function canceledRollbackFailed(
  fullPath: string,
  cause: unknown,
  undo: 'remove' | 'restore' = 'remove',
): Error & { code: string } {
  const code = codeOf(cause) ?? 'storage/unknown';
  const reason = cause instanceof Error ? cause.message : String(cause);
  const failed = UNDO_FAILED[undo];
  const message = `${code}: The upload to '${fullPath}' was canceled after it was stored, and ${failed}: ${reason}`;
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;
  return error;
}
