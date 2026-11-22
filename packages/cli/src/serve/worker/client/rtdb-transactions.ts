/** Optimistic RTDB transaction loop over the worker RPC boundary. */
import { runSdkWrite } from 'pyric/sandbox/internal';
import { validateWritablePath } from 'pyric/database/internal';
import { beginWorkerDatabaseActivity } from './sdk-activity.js';
import { nextId } from './core.js';
import {
  beginWorkerColdTransaction,
  isWorkerPathWarm,
  markWorkerPathsWarm,
} from './rtdb-client-cache.js';
import {
  isWorkerInstanceOffline,
  recordWorkerOnlineGetWire,
  runWorkerOfflineTransaction,
} from './rtdb-offline-state.js';
import { readAuthoritativeWarmTransactionWire } from './rtdb-server-mirror.js';
import {
  hasOverlappingActiveRtdbTransaction,
  rtdbRpc,
  withRtdbTransactionBarrier,
  withRtdbTransactionUpdate,
} from './rtdb-references.js';
import type { RtdbDataSnapshot, RtdbRefHandle } from './handles.js';
import {
  hydrateRtdbSnapshot,
  makeRtdbSnapshot,
  type RtdbWireSnapshot,
} from './rtdb-snapshots.js';
import { validateRtdbTransactionValue } from './rtdb-value-validation.js';

export interface RtdbTransactionOptions {
  readonly applyLocally?: boolean;
}

export interface RtdbTransactionResult {
  readonly committed: boolean;
  readonly snapshot: RtdbDataSnapshot;
  toJSON(): { committed: boolean; snapshot: unknown };
}

interface RtdbTransactionCommitReply {
  readonly retry?: boolean;
  readonly committed: boolean;
  readonly snapshot: RtdbWireSnapshot;
}

function transactionResult(
  committed: boolean,
  snapshot: RtdbDataSnapshot,
): RtdbTransactionResult {
  return {
    committed,
    snapshot,
    toJSON: () => ({ committed, snapshot: snapshot.toJSON() }),
  };
}

async function runWarmTransactionLoop<T>(
  ref: RtdbRefHandle,
  transactionUpdate: (current: T | null) => T | undefined,
  options: RtdbTransactionOptions | undefined,
  startAttempt: number,
): Promise<RtdbTransactionResult> {
  for (let attempt = startAttempt; attempt < 25; attempt += 1) {
    const rawBefore = await rtdbRpc(ref, {
      t: 'op', id: nextId(), method: 'rtdb.get', path: ref.path, transaction: true,
    });
    recordWorkerOnlineGetWire(ref, undefined, rawBefore);
    const before = hydrateRtdbSnapshot(ref, rawBefore);
    const expected = before.val() as T | null;
    let current: T | null = null;
    if (expected !== null) {
      current = structuredClone(expected);
    }
    const value = withRtdbTransactionUpdate(() => transactionUpdate(current));
    if (value === undefined) {
      markWorkerPathsWarm(ref, [ref.path]);
      return transactionResult(false, before);
    }
    validateRtdbTransactionValue(value, ref.path);
    // A commit in flight at a hosted drop rejects with Error('disconnect') and is not retried (#1088).
    const wire = await rtdbRpc(ref, {
      t: 'op',
      id: nextId(),
      method: 'rtdb.transactionCommit',
      path: ref.path,
      expected,
      value,
      applyLocally: options?.applyLocally,
    }) as RtdbTransactionCommitReply;
    recordWorkerOnlineGetWire(ref, undefined, wire.snapshot);
    const snapshot = hydrateRtdbSnapshot(ref, wire.snapshot);
    if (!wire.retry) {
      markWorkerPathsWarm(ref, [ref.path]);
      return transactionResult(wire.committed, snapshot);
    }
  }
  throw new Error('maxretry');
}

export function rtdbRunTransaction<T>(
  ref: RtdbRefHandle,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: RtdbTransactionOptions,
): Promise<RtdbTransactionResult> {
  validateWritablePath('Reference.transaction', ref.path);
  if (typeof transactionUpdate !== 'function') {
    throw new TypeError('transactionUpdate must be a function');
  }
  const activity = beginWorkerDatabaseActivity(ref, 'runTransaction', 'operation');
  try {
    if (isWorkerInstanceOffline(ref)) {
      const applyLocally = options?.applyLocally !== false;
      const offlineOutcome = runWorkerOfflineTransaction(
        ref,
        transactionUpdate,
        applyLocally,
        (snap) => transactionResult(false, snap),
        async (initialInput, proposed0) =>
          withRtdbTransactionBarrier(ref, async () => {
            const wire0 = await rtdbRpc(ref, {
              t: 'op',
              id: nextId(),
              method: 'rtdb.transactionCommit',
              path: ref.path,
              expected: initialInput,
              value: proposed0,
              applyLocally: options?.applyLocally,
            }) as RtdbTransactionCommitReply;
            recordWorkerOnlineGetWire(ref, undefined, wire0.snapshot);
            if (!wire0.retry) {
              markWorkerPathsWarm(ref, [ref.path]);
              return transactionResult(wire0.committed, hydrateRtdbSnapshot(ref, wire0.snapshot));
            }
            markWorkerPathsWarm(ref, [ref.path]);
            return runWarmTransactionLoop(ref, transactionUpdate, options, 1);
          }),
      );
      return runSdkWrite(activity, () => offlineOutcome);
    }
    const hadOverlappingTxn = hasOverlappingActiveRtdbTransaction(ref);
    const isWarmPath = isWorkerPathWarm(ref, ref.path);
    if (isWarmPath || hadOverlappingTxn) {
      let warmWire0: RtdbWireSnapshot | undefined;
      if (!hadOverlappingTxn && isWarmPath) {
        warmWire0 = readAuthoritativeWarmTransactionWire(ref);
      }
      if (warmWire0 !== undefined) {
        const expected0 = warmWire0.value as T | null;
        let current0: T | null = null;
        if (expected0 !== null) {
          current0 = structuredClone(expected0);
        }
        const warmValue0 = withRtdbTransactionUpdate(() => transactionUpdate(current0));
        if (warmValue0 === undefined) {
          return runSdkWrite(activity, () =>
            withRtdbTransactionBarrier(ref, async () => {
              const rawAbort = await rtdbRpc(ref, {
                t: 'op', id: nextId(), method: 'rtdb.get', path: ref.path, transaction: true,
              });
              recordWorkerOnlineGetWire(ref, undefined, rawAbort);
              markWorkerPathsWarm(ref, [ref.path]);
              return transactionResult(false, hydrateRtdbSnapshot(ref, rawAbort));
            }),
          );
        }
        validateRtdbTransactionValue(warmValue0, ref.path);
        return runSdkWrite(activity, () =>
          withRtdbTransactionBarrier(ref, async () => {
            const wire0 = await rtdbRpc(ref, {
              t: 'op',
              id: nextId(),
              method: 'rtdb.transactionCommit',
              path: ref.path,
              expected: expected0,
              value: warmValue0,
              applyLocally: options?.applyLocally,
            }) as RtdbTransactionCommitReply;
            recordWorkerOnlineGetWire(ref, undefined, wire0.snapshot);
            if (!wire0.retry) {
              markWorkerPathsWarm(ref, [ref.path]);
              return transactionResult(wire0.committed, hydrateRtdbSnapshot(ref, wire0.snapshot));
            }
            markWorkerPathsWarm(ref, [ref.path]);
            return runWarmTransactionLoop(ref, transactionUpdate, options, 1);
          }),
        );
      }
      const probe0 = withRtdbTransactionUpdate(() => transactionUpdate(null));
      if (probe0 !== undefined) {
        validateRtdbTransactionValue(probe0, ref.path);
      }
      return runSdkWrite(activity, () =>
        withRtdbTransactionBarrier(ref, () =>
          runWarmTransactionLoop(ref, transactionUpdate, options, 0),
        ),
      );
    }
    const value0 = withRtdbTransactionUpdate(() => transactionUpdate(null));
    if (value0 === undefined) {
      return runSdkWrite(activity, async () => {
        await Promise.resolve();
        return transactionResult(false, makeRtdbSnapshot(ref, null, false, null, [], null));
      });
    }
    validateRtdbTransactionValue(value0, ref.path);
    const sent = beginWorkerColdTransaction(ref, ref.path);
    return runSdkWrite(activity, async () => {
      let wire0: RtdbTransactionCommitReply;
      try {
        wire0 = await rtdbRpc(ref, {
          t: 'op',
          id: nextId(),
          method: 'rtdb.transactionCommit',
          path: ref.path,
          expected: null,
          value: value0,
          applyLocally: options?.applyLocally,
        }) as RtdbTransactionCommitReply;
      } finally {
        sent.release();
      }
      recordWorkerOnlineGetWire(ref, undefined, wire0.snapshot);
      if (!wire0.retry) {
        markWorkerPathsWarm(ref, [ref.path]);
        return transactionResult(wire0.committed, hydrateRtdbSnapshot(ref, wire0.snapshot));
      }
      if (sent.isAbortedBySet()) {
        throw new Error('set');
      }
      markWorkerPathsWarm(ref, [ref.path]);
      return withRtdbTransactionBarrier(ref, () =>
        runWarmTransactionLoop(ref, transactionUpdate, options, 1),
      );
    });
  } catch (error) {
    activity.fail();
    throw error;
  }
}
