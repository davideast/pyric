import { describe, expect, it } from 'bun:test';
import {
  get,
  increment,
  ref,
  runTransaction,
  set,
  TARGET_SYMBOL,
} from '../../../src/database/index.js';
import { loadObservation, setup } from './cdd-replay-helpers.js';

const concurrentObservation = loadObservation('rtdb-modular-concurrent-transforms');

describe('RTDB CDD transaction contention cases', () => {
  it('rtdb-modular#157 documents synchronous increment serialization', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/increment');
    await set(target, 0);
    const firstWrite = set(target, increment(2));
    expect(first[TARGET_SYMBOL].backend.adminGet('/contention/increment')).toBe(2);
    const secondWrite = set(ref(second, 'contention/increment'), increment(3));
    await Promise.all([firstWrite, secondWrite]);
    expect((await get(target)).val()).toBe(concurrentObservation.incrementTerminal);
  });

  it('rtdb-modular#161 documents ordinary concurrent transaction serialization', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/transaction');
    await set(target, 0);
    const calls = [0, 0];
    const results = await Promise.all([
      runTransaction(target, (current) => {
        calls[0] += 1;
        return ((current as number | null) ?? 0) + 1;
      }),
      runTransaction(ref(second, 'contention/transaction'), (current) => {
        calls[1] += 1;
        return ((current as number | null) ?? 0) + 1;
      }),
    ]);
    expect(calls).toEqual([1, 1]);
    expect(calls).not.toEqual(concurrentObservation.invocationCountsSorted);
    expect(results.map((result) => result.committed)).toEqual(concurrentObservation.committed);
    expect(results.map((result) => result.snapshot.val()).sort()).toEqual(
      concurrentObservation.finalSnapshotsSorted,
    );
    expect((await get(target)).val()).toBe(concurrentObservation.transactionTerminal);
  });

  it('retries a transaction after a synchronous re-entrant conflicting write', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/reentrant-transaction');
    await set(target, 0);
    const seen: unknown[] = [];
    let injected = false;
    const result = await runTransaction(target, (current) => {
      seen.push(current);
      if (!injected) {
        injected = true;
        void set(ref(second, 'contention/reentrant-transaction'), 10);
      }
      return ((current as number | null) ?? 0) + 1;
    });
    expect(seen).toEqual([0, 10]);
    expect(seen.length > 1).toBe(concurrentObservation.retryObserved);
    expect(result.committed).toBe(true);
    expect(result.snapshot?.val()).toBe(11);

    const unrelated = ref(first, 'contention/unrelated-transaction');
    await set(unrelated, 0);
    let unrelatedCalls = 0;
    const unrelatedResult = await runTransaction(unrelated, (current) => {
      unrelatedCalls += 1;
      void set(ref(second, 'contention/other-path'), unrelatedCalls);
      return ((current as number | null) ?? 0) + 1;
    });
    expect(unrelatedCalls).toBe(1);
    expect(unrelatedResult.committed).toBe(true);
    expect(unrelatedResult.snapshot?.val()).toBe(1);
  });

  it('releases path-version history after transaction conflict checks', async () => {
    const { first } = setup();
    const backend = first[TARGET_SYMBOL].backend as unknown as {
      transactionMutationHistory: unknown[];
    };
    for (let index = 0; index < 100; index++) {
      await set(ref(first, `history/${index}`), index);
    }
    await runTransaction(ref(first, 'history/transaction'), (current) =>
      ((current as number | null) ?? 0) + 1);
    expect(backend.transactionMutationHistory).toHaveLength(0);
  });
});
