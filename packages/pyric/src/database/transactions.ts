import type { JsonValue } from './sandbox/data-tree.js';
import { authFor, targetOf } from './routing.js';
import type { DataSnapshot, DatabaseReference } from './types.js';
import { buildSandboxSnapFromRaw } from './snapshots.js';

// ─── Transactions (Tier 4) ───────────────────────────────────────────

/**
 * Result of {@link runTransaction}. Matches `firebase/database`'s
 * `TransactionResult` for the fields agent / playground code reads
 * idiomatically.
 *
 * `committed === false` when the update fn aborted by returning
 * `undefined`. The snapshot still resolves — it reflects the **pre-
 * transaction** value (oracle:
 * `rtdb-modular-runtransaction-abort-undefined.json` →
 * `afterValOnServer: 100` preserved).
 *
 * On rule denial the promise rejects with a plain `Error` whose
 * `message === 'permission_denied'` (lowercase, no `.code`); see
 * `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 */
export class TransactionResult {
  constructor(
    readonly committed?: boolean,
    readonly snapshot?: DataSnapshot,
  ) {}

  toJSON(): { committed: boolean | undefined; snapshot: JsonValue | undefined } {
    return { committed: this.committed, snapshot: this.snapshot?.toJSON() };
  }
}

export interface TransactionOptions {
  readonly applyLocally?: boolean;
}

/**
 * `runTransaction(ref, transactionUpdate, options?)` — atomic
 * read-modify-write.
 *
 * Contract (oracle-locked):
 *
 *   1. `transactionUpdate` is called with the CURRENT value at `ref`'s
 *      path. For an absent path the arg is `null` (NOT `undefined`);
 *      oracle:
 *      `rtdb-modular-runtransaction-current-value-arg.json` →
 *      `missingFirstWasNull: true`.
 *   2. Returning `undefined` from the update fn ABORTS the transaction:
 *      resolves `{ committed: false, snapshot }` where the snapshot is
 *      the pre-transaction value; oracle:
 *      `rtdb-modular-runtransaction-abort-undefined.json` → `committed:
 *      false, snapVal: null`.
 *   3. Returning any defined value WRITES that value (rules-checked);
 *      resolves `{ committed: true, snapshot }` where `snapshot.val()`
 *      is the committed value; oracle:
 *      `rtdb-modular-runtransaction-success.json` → `committedNewValue:
 *      true` and
 *      `rtdb-modular-runtransaction-returns-committed-snapshot.json`.
 *   4. If rules deny the write, the promise REJECTS with a plain
 *      `Error` whose `message === 'permission_denied'` and NO `.code`
 *      field (distinct from `set`/`get`'s `'PERMISSION_DENIED:
 *      Permission denied'`); oracle:
 *      `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 *
 * `options.applyLocally` (default `true`): when `false`, the
 * intermediate optimistic value is NOT fanned out to listeners — they
 * see only the committed value. In a single-client harness this is
 * usually invisible; we honor the flag for prod-parity. Oracle
 * observation `rtdb-modular-runtransaction-options-applylocally.json`
 * confirms both branches commit and end at the same value; the
 * intermediate-fire difference isn't observable from a single client.
 *
 * Single-client sandbox doesn't model concurrency conflicts; the
 * documented "retry on conflict" path is degenerate (no other writer
 * exists to conflict with). The fn is invoked once.
 */
export async function runTransaction<T>(
  r: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: TransactionOptions,
): Promise<TransactionResult> {
  const target = targetOf(r as unknown as object);
  const result = target.backend.runTransaction(
    authFor(target),
    r._path,
    transactionUpdate as (current: JsonValue) => JsonValue | undefined,
    options,
  );
  const snap = buildSandboxSnapFromRaw(target, r, result.val);
  return new TransactionResult(result.committed, snap) as TransactionResult & {
    committed: boolean;
    snapshot: DataSnapshot;
  };
}
