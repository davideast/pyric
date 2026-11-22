import { runSdkWrite } from '../sandbox/internal/sdk-write-activity.js';
import { createClientTransactionHooks } from './client-cache-state.js';
import { isClientOffline, runOfflineClientTransaction } from './offline-client-state.js';
import { beginDatabaseActivity } from './sdk-activity.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { authFor, isAdminFor, targetOf } from './routing.js';
import type { DataSnapshot, DatabaseReference } from './types.js';
import { buildSandboxSnapFromRaw } from './snapshots.js';
import { validateWritablePath } from './writable-path.js';

// --- Transactions (Tier 4) ---

/**
 * Result of {@link runTransaction}. Matches `firebase/database`'s
 * `TransactionResult` for the fields agent / playground code reads
 * idiomatically.
 *
 * `committed === false` when the update fn aborted by returning
 * `undefined`. The snapshot still resolves -- it reflects the **pre-
 * transaction** value (oracle:
 * `rtdb-modular-runtransaction-abort-undefined.json` ->
 * `afterValOnServer: 100` preserved).
 *
 * On rule denial the promise rejects with a plain `Error` whose
 * `message === 'permission_denied'` (lowercase, no `.code`); see
 * `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 */
export class TransactionResult {
  readonly committed: boolean;
  readonly snapshot: DataSnapshot;

  constructor(committed?: boolean, snapshot?: DataSnapshot) {
    // The runtime constructor is directly callable like Firebase's emitted
    // class, while ordinary API results always provide both required fields.
    this.committed = committed as boolean;
    this.snapshot = snapshot as DataSnapshot;
  }

  toJSON(): { committed: boolean | undefined; snapshot: JsonValue | undefined } {
    return { committed: this.committed, snapshot: this.snapshot?.toJSON() };
  }
}

export interface TransactionOptions {
  readonly applyLocally?: boolean;
}

/**
 * `runTransaction(ref, transactionUpdate, options?)` -- atomic
 * read-modify-write.
 *
 * Contract (oracle-locked):
 *
 *   1. `transactionUpdate` is called with the caller-visible value at
 *      `ref`'s path (`null` for an absent path or when `.read` rules
 *      deny the caller, NOT `undefined`); oracle:
 *      `rtdb-modular-runtransaction-current-value-arg.json` ->
 *      `missingFirstWasNull: true`.
 *   2. Returning `undefined` from the update fn ABORTS the transaction:
 *      resolves `{ committed: false, snapshot }` where the snapshot is
 *      the caller-visible pre-transaction value (`null` when `.read` is
 *      denied); oracle:
 *      `rtdb-modular-runtransaction-abort-undefined.json` -> `committed:
 *      false, snapVal: null`.
 *   3. Returning any defined value WRITES that value (rules-checked);
 *      resolves `{ committed: true, snapshot }` where `snapshot.val()`
 *      is the committed value; oracle:
 *      `rtdb-modular-runtransaction-success.json` -> `committedNewValue:
 *      true` and
 *      `rtdb-modular-runtransaction-returns-committed-snapshot.json`.
 *   4. If rules deny the write, the promise REJECTS with a plain
 *      `Error` whose `message === 'permission_denied'` and NO `.code`
 *      field (distinct from `set`/`get`'s `'PERMISSION_DENIED:
 *      Permission denied'`); oracle:
 *      `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 *
 * `options.applyLocally` (default `true`): when `false`, the
 * intermediate optimistic value is NOT fanned out to listeners -- they
 * see only the committed value.
 *
 * The initial attempt runs synchronously (`repoStartTransaction`), so an
 * invalid return value throws synchronously (#1224).
 */
export function runTransaction<T>(
  r: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: TransactionOptions,
): Promise<TransactionResult> {
  validateWritablePath('Reference.transaction', r._path);
  if (typeof transactionUpdate !== 'function') {
    throw new TypeError('transactionUpdate must be a function');
  }
  const target = targetOf(r as unknown as object);
  const { cold, hooks } = createClientTransactionHooks(target, r._path);
  const activity = beginDatabaseActivity(r, 'runTransaction', 'operation');
  let outcomePromise: Promise<TransactionResult>;
  try {
    const admin = isAdminFor(target);
    if (!admin && isClientOffline(target)) {
      const applyLocally = options?.applyLocally !== false;
      outcomePromise = runOfflineClientTransaction(
        target,
        r,
        transactionUpdate,
        applyLocally,
        hooks,
        (rawVal, priorities) =>
          new TransactionResult(false, buildSandboxSnapFromRaw(target, r, rawVal, priorities)),
        async (wrappedUpdate) => {
          const outcome = await target.backend.runClientTransactionAsync(
            authFor(target),
            r._path,
            wrappedUpdate,
            { applyLocally: options?.applyLocally, admin: false, cold: false, hooks },
          );
          const snap = buildSandboxSnapFromRaw(target, r, outcome.val, outcome.priorities);
          return new TransactionResult(outcome.committed, snap);
        },
      );
    } else {
      outcomePromise = target.backend
        .runClientTransactionAsync(
          authFor(target),
          r._path,
          transactionUpdate as (current: JsonValue) => JsonValue | undefined,
          {
            applyLocally: options?.applyLocally,
            admin,
            cold,
            hooks,
          },
        )
        .then((result) => {
          const snap = buildSandboxSnapFromRaw(target, r, result.val, result.priorities);
          return new TransactionResult(result.committed, snap);
        });
    }
  } catch (error) {
    activity.fail();
    throw error;
  }
  return runSdkWrite(activity, () => outcomePromise);
}
