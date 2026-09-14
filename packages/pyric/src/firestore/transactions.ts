/**
 * `pyric/firestore` — transactions + batched writes.
 *
 * `runTransaction` and `writeBatch`. Handles resolve a chainable bound to
 * the current user and freeze that identity for the duration.
 */
import { runSdkWrite } from '../sandbox/internal/sdk-write-activity.js';
import { beginFirestoreGroupActivity } from './sdk-activity.js';
import type { Transaction as ChainTransaction } from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  sandboxDb,
  tag,
} from './state.js';
import type { Firestore, Transaction, TransactionOptions, WriteBatch } from './types.js';

// ─── Transactions + batches ───────────────────────────────────────────

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
  options?: TransactionOptions,
): Promise<R> {
  const target = targetOf(db);
  // For sandbox-live, the transaction runs under the auth captured at
  // `runTransaction` start and stays identity-stable until completion.
  return runSdkWrite(beginFirestoreGroupActivity(target, 'runTransaction'), () => sandboxDb(target).runTransaction(
    fn as (tx: ChainTransaction) => Promise<R> | R,
    options,
  ));
}

export function writeBatch(db: Firestore): WriteBatch {
  const target = targetOf(db);
  const batch = sandboxDb(target).batch();
  let writes = 0;
  let deletes = 0;
  const set = batch.set.bind(batch);
  const update = batch.update.bind(batch);
  const remove = batch.delete.bind(batch);
  batch.set = (...args) => { const result = set(...args); ++writes; return result; };
  batch.update = (...args) => { const result = update(...args); ++writes; return result; };
  batch.delete = (...args) => { const result = remove(...args); ++deletes; return result; };
  const commit = batch.commit.bind(batch);
  batch.commit = () => runSdkWrite(beginFirestoreGroupActivity(target, 'writeBatch.commit'), commit, () => ({ documentWrites: writes, documentDeletes: deletes }));
  return tag(batch as unknown as object, target) as WriteBatch;
}
