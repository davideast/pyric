/**
 * Rolling back a canceled upload. A commit that was already sent cannot be
 * recalled, so a cancel that races it deletes what it stored. A canceled
 * upload leaves no object, as the Firebase SDK guarantees, and the task
 * rejects only once that holds.
 */
import type { FullMetadata } from 'pyric/storage';
import type { ClientStorageReference } from './storage.js';
import { deleteObject } from './storage.js';

/** How a sent commit settled: the object it stored, or why it failed. */
export type CommitOutcome = { result: { metadata: FullMetadata } } | { error: unknown };

export function commitOutcomeOf(commit: Promise<FullMetadata>): Promise<CommitOutcome> {
  return commit.then(
    (metadata) => ({ result: { metadata } }),
    (error: unknown) => ({ error }),
  );
}

export function storedObject(outcome: CommitOutcome | undefined): boolean {
  return outcome !== undefined && 'result' in outcome;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return undefined;
}

/** Delete what a canceled commit stored. An object already gone is rolled back. */
export async function removeStoredObject(reference: ClientStorageReference): Promise<void> {
  try {
    await deleteObject(reference);
  } catch (error: unknown) {
    const alreadyGone = codeOf(error) === 'storage/object-not-found';
    if (!alreadyGone) throw error;
  }
}

/**
 * The rejection of a cancel whose rollback failed. It carries the delete's
 * code, not `storage/canceled`, because the object the upload stored is still
 * there, and `storage/canceled` promises it is not.
 */
export function rollbackFailedError(reference: ClientStorageReference, cause: unknown): Error & { code: string } {
  const code = codeOf(cause) ?? 'storage/unknown';
  const reason = cause instanceof Error ? cause.message : String(cause);
  const message = `${code}: The upload to '${reference.fullPath}' was canceled after it was stored, and removing it failed: ${reason}`;
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;
  return error;
}
