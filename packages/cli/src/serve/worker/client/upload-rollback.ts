/**
 * Rolling back a canceled upload. A commit that was already sent cannot be
 * recalled, so a cancel that races it undoes what it stored. A canceled
 * upload leaves the path as it found it, as the Firebase SDK guarantees, and
 * the task rejects only once that holds.
 *
 * Production never stores a canceled upload, so its rules never see a delete
 * for one. The commit therefore asks the host for a rollback token, and the
 * rollback redeems it: without evaluating rules, the host puts back the
 * object that commit replaced (#1159), or deletes the generation it stored
 * when it replaced none (#1157). A host that sent no token, or refused it,
 * gets the delete the rules decide instead. That delete cannot bring back an
 * object the commit replaced, so when the receipt says it replaced one, the
 * rollback fails instead and the upload's object stays.
 */
import { FirebaseError } from 'pyric/app';
import { canceledRollbackFailed } from 'pyric/storage/internal';
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

/**
 * Roll back by token; false when the host sent no token or refused it
 * (`storage/unauthorized`). Any other failure is the rollback's own.
 */
async function rolledBackByToken(reference: ClientStorageReference, rollbackToken: string | undefined): Promise<boolean> {
  const hasToken = rollbackToken !== undefined;
  if (!hasToken) return false;
  try {
    await rollBackUpload(reference, rollbackToken);
    return true;
  } catch (error: unknown) {
    const refused = codeOf(error) === 'storage/unauthorized';
    if (refused) return false;
    throw error;
  }
}

/** Without a token, the delete the rules decide: it undoes a commit that created the object. */
async function deleteWithRules(reference: ClientStorageReference, stored: CommittedUpload): Promise<void> {
  if (stored.replacedObject === true) {
    throw new FirebaseError('storage/unknown', 'The host no longer holds the object this upload replaced, so it cannot be restored.');
  }
  try {
    await deleteObject(reference);
  } catch (error: unknown) {
    const alreadyGone = codeOf(error) === 'storage/object-not-found';
    if (!alreadyGone) throw error;
  }
}

/** What the rollback undoes, for the error it fails with. */
function undoOf(stored: CommittedUpload): 'remove' | 'restore' {
  if (stored.replacedObject === true) return 'restore';
  return 'remove';
}

/**
 * Undo what a canceled commit stored. An object already gone, or replaced by
 * a later write, is rolled back. A failure rejects with the error the cancel
 * ends with, worded for the restore or the removal it was.
 */
export async function removeStoredObject(reference: ClientStorageReference, stored: CommittedUpload): Promise<void> {
  try {
    const rolledBack = await rolledBackByToken(reference, stored.rollbackToken);
    if (!rolledBack) await deleteWithRules(reference, stored);
  } catch (cause: unknown) {
    throw canceledRollbackFailed(reference.fullPath, cause, undoOf(stored));
  }
}
