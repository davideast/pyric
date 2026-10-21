/**
 * Rolling back a canceled upload. A commit that was already sent cannot be
 * recalled, so a cancel that races it deletes what it stored. A canceled
 * upload leaves no object, as the Firebase SDK guarantees, and the task
 * rejects only once that holds.
 *
 * Production never stores a canceled upload, so its rules never see a delete
 * for one. The commit therefore asks the host for a rollback token, and the
 * rollback redeems it: the host deletes the generation that commit stored
 * without evaluating rules (#1157). A host that sent no token, or refused it,
 * gets the delete the rules decide instead.
 */
import type { ClientStorageReference, CommittedUpload } from './storage.js';
import { deleteObject, rollBackUpload } from './storage.js';

/** How a sent commit settled: the object it stored, or why it failed. */
export type CommitOutcome = { result: CommittedUpload } | { error: unknown };

export function commitOutcomeOf(commit: Promise<CommittedUpload>): Promise<CommitOutcome> {
  return commit.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

/** The upload a commit stored, or undefined when it stored nothing. */
export function storedUpload(outcome: CommitOutcome | undefined): CommittedUpload | undefined {
  const stored = outcome !== undefined && 'result' in outcome;
  return stored ? outcome.result : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return undefined;
}

/** Roll back by token; false when the host sent none or refused it. */
async function rolledBackByToken(reference: ClientStorageReference, rollbackToken: string | undefined): Promise<boolean> {
  const hasToken = rollbackToken !== undefined;
  if (!hasToken) return false;
  try {
    await rollBackUpload(reference, rollbackToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete what a canceled commit stored. An object already gone, or replaced
 * by a later write, is rolled back.
 */
export async function removeStoredObject(reference: ClientStorageReference, stored: CommittedUpload): Promise<void> {
  const rolledBack = await rolledBackByToken(reference, stored.rollbackToken);
  if (rolledBack) return;
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
