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
import type { EventProvenance } from 'pyric/sandbox';
import { deleteObjectGeneration } from './download.js';
import type { StoredObject } from './persistence.js';
import type { StorageReference } from './reference.js';
import { getStorageService } from './service.js';

/**
 * Put `prior` back at `ref` only while the object there is still
 * `generation`. Resolves false, writing nothing, when the object is gone or a
 * later write replaced that generation.
 */
export async function restoreObjectGeneration(
  ref: StorageReference,
  generation: string,
  prior: StoredObject,
): Promise<boolean> {
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  const isThatGeneration = existing !== undefined && existing.generation === generation;
  if (!isThatGeneration) return false;
  await service.backend.put(ref.fullPath, prior.blob, prior.metadata);
  return true;
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
 */
export async function rollBackCanceledCommit(
  ref: StorageReference,
  commit: CanceledCommit,
  provenance?: EventProvenance,
): Promise<void> {
  const prior = commit.prior;
  const replacedAnObject = prior !== undefined;
  if (replacedAnObject) {
    await restoreObjectGeneration(ref, commit.generation, prior);
    return;
  }
  await deleteObjectGeneration(ref, commit.generation, provenance);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return undefined;
}

/**
 * The rejection of a cancel whose rollback failed. It carries the rollback's
 * code, not `storage/canceled`, because the object the upload stored is still
 * there, and `storage/canceled` promises it is not. The worker client builds
 * the same error.
 */
export function canceledRollbackFailed(fullPath: string, cause: unknown): Error & { code: string } {
  const code = codeOf(cause) ?? 'storage/unknown';
  const reason = cause instanceof Error ? cause.message : String(cause);
  const message = `${code}: The upload to '${fullPath}' was canceled after it was stored, and removing it failed: ${reason}`;
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;
  return error;
}
