/**
 * `pyric/firestore` — transactions + batched writes.
 *
 * `runTransaction` and `writeBatch`. Sandbox handles resolve a chainable
 * bound to the current user and freeze that identity for the duration;
 * prod handles forward to `firebase/firestore`.
 */
import * as fb from 'firebase/firestore';
import type { Transaction as ChainTransaction } from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  sandboxDb,
  tag,
} from './state.js';
import type { Firestore, Transaction, WriteBatch } from './types.js';

// ─── Transactions + batches ───────────────────────────────────────────

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
): Promise<R> {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // For sandbox-live, the transaction (and every op inside the
    // callback) runs under the auth captured at `runTransaction`
    // start. Mutating `sandbox.currentUser` mid-transaction does
    // not retro-actively re-auth in-flight reads (matches
    // production: a transaction is identity-stable by design).
    return sandboxDb(target).runTransaction(fn as (tx: ChainTransaction) => Promise<R> | R);
  }
  return fb.runTransaction(target.db, fn as (tx: fb.Transaction) => Promise<R>);
}

export function writeBatch(db: Firestore): WriteBatch {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // Each batch is constructed under a fresh chainable bound to
    // the current user. The batch holds that identity for every
    // op queued through it (matches transactions — once a batch is
    // opened, identity is frozen until `.commit()`).
    const batch = sandboxDb(target).batch();
    return tag(batch as unknown as object, target) as WriteBatch;
  }
  const batch = fb.writeBatch(target.db);
  return tag(batch as unknown as object, target) as WriteBatch;
}
