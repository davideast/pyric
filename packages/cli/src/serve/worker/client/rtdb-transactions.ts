/** RTDB optimistic transactions over the worker port. */
import { dataRpc, nextId } from "./core.js";
import type { RtdbDataSnapshot, RtdbRefHandle } from "./handles.js";
import { rtdbGet } from "./rtdb-operations.js";
import { hydrateRtdbSnapshot, type RtdbWireSnapshot } from "./rtdb-snapshots.js";

export interface RtdbTransactionOptions {
  readonly applyLocally?: boolean;
}

export interface RtdbTransactionResult {
  readonly committed: boolean;
  readonly snapshot: RtdbDataSnapshot;
  toJSON(): { committed: boolean; snapshot: unknown };
}

function transactionResult(committed: boolean, snapshot: RtdbDataSnapshot): RtdbTransactionResult {
  return {
    committed,
    snapshot,
    toJSON: () => ({ committed, snapshot: snapshot.toJSON() }),
  };
}

export async function rtdbRunTransaction<T>(
  r: RtdbRefHandle,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: RtdbTransactionOptions,
): Promise<RtdbTransactionResult> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const before = await rtdbGet(r);
    const expected = before.val() as T | null;
    const value = transactionUpdate(expected);
    if (value === undefined) return transactionResult(false, before);
    const wire = await dataRpc(r.port, {
      t: 'op',
      id: nextId(),
      method: 'rtdb.transactionCommit',
      path: r.path,
      expected,
      value,
      applyLocally: options?.applyLocally,
    }) as { retry?: boolean; committed: boolean; snapshot: RtdbWireSnapshot };
    const snapshot = hydrateRtdbSnapshot(r, wire.snapshot);
    if (!wire.retry) return transactionResult(wire.committed, snapshot);
  }
  throw new Error('maxretry');
}
