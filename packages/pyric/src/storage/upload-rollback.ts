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
 * What a commit replaced, as its rollback keeps it: nothing, the object with
 * the bytes it holds in memory, or an object too large to keep, which a
 * rollback cannot put back.
 */
export type ReplacedAtCommit =
  | { readonly kind: 'none' }
  | { readonly kind: 'kept'; readonly object: StoredObject; readonly heldBytes: number }
  | { readonly kind: 'too-large'; readonly size: number };

/**
 * Keep the object a commit replaced, as the backend's write returned it
 * (`uploadObjectReplacing`). A backend that reads replaced objects from files
 * on disk holds no bytes for it; elsewhere an object larger than
 * `maxHeldBytes` is not kept.
 */
export async function keepReplacedObject(
  ref: StorageReference,
  replaced: StoredObject | undefined,
  maxHeldBytes: number,
): Promise<ReplacedAtCommit> {
  if (replaced === undefined) return { kind: 'none' };
  const backend = (await getStorageService(ref.storage)).backend;
  const onDisk = backend.replacedObjectsOnDisk === true;
  if (onDisk) return { kind: 'kept', object: replaced, heldBytes: 0 };
  const size = replaced.blob.size;
  const tooLarge = size > maxHeldBytes;
  if (tooLarge) return { kind: 'too-large', size };
  return { kind: 'kept', object: replaced, heldBytes: size };
}

/**
 * Put `prior` back at `ref` only while the object there is still
 * `generation`, checked and written in one backend transaction. Resolves
 * false, writing nothing, when the object is gone or a later write replaced
 * that generation.
 */
export async function restoreObjectGeneration(
  ref: StorageReference,
  generation: string,
  prior: StoredObject,
  provenance?: EventProvenance,
): Promise<boolean> {
  const backend = (await getStorageService(ref.storage)).backend;
  // Read for the event only; the write below checks the generation itself.
  const before = await backend.getMetadata(ref.fullPath);
  const restored = await backend.replaceIfGeneration(ref.fullPath, generation, prior);
  if (restored) emitObjectRestore(ref, before, prior.metadata, provenance);
  return restored;
}

/** Land the restore on the sandbox stream as the `object_put` it is. */
function emitObjectRestore(
  ref: StorageReference,
  replaced: StoredMetadata | undefined,
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
 * How a rollback ended: `deleted` when the commit had created the object and
 * it is gone, `restored` when the object it replaced is back, neither when a
 * later write had replaced the commit's generation and was kept, and `error`,
 * the error the cancel ends with, when the rollback failed.
 */
export interface RollbackOutcome {
  readonly deleted: boolean;
  readonly restored: boolean;
  readonly error?: Error;
}

/**
 * Undo a canceled commit: restore the object it replaced, or delete the one
 * it created, in both cases only while its own generation is still there.
 * Never rejects; a failed rollback resolves with its `error`.
 */
export async function undoCanceledCommit(
  ref: StorageReference,
  commit: CanceledCommit,
  provenance?: EventProvenance,
): Promise<RollbackOutcome> {
  const prior = commit.prior;
  if (prior !== undefined) {
    return restoreObjectGeneration(ref, commit.generation, prior, provenance).then(
      (restored) => ({ deleted: false, restored }),
      (cause: unknown) => ({ deleted: false, restored: false, error: canceledRollbackFailed(ref.fullPath, cause, 'restore') }),
    );
  }
  return deleteObjectGeneration(ref, commit.generation, provenance).then(
    (deleted) => ({ deleted, restored: false }),
    (cause: unknown) => ({ deleted: false, restored: false, error: canceledRollbackFailed(ref.fullPath, cause, 'remove') }),
  );
}

/**
 * Undo a canceled commit, as {@link undoCanceledCommit} does. Resolves the
 * error the cancel ends with when the rollback fails.
 */
export async function rollBackCanceledCommit(
  ref: StorageReference,
  commit: CanceledCommit,
  provenance?: EventProvenance,
): Promise<Error | undefined> {
  const outcome = await undoCanceledCommit(ref, commit, provenance);
  return outcome.error;
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
