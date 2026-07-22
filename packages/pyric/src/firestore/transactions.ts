/**
 * `pyric/firestore` — transactions + batched writes.
 *
 * `runTransaction` and `writeBatch`. Handles resolve a chainable bound to
 * the current user and freeze that identity for the duration.
 */
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
  return sandboxDb(target).runTransaction(
    fn as (tx: ChainTransaction) => Promise<R> | R,
    options,
  );
}

export function writeBatch(db: Firestore): WriteBatch {
  const target = targetOf(db);
  const batch = sandboxDb(target).batch();
  return tag(batch as unknown as object, target) as WriteBatch;
}
