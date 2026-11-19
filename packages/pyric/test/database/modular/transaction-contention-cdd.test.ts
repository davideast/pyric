import { describe, expect, it } from 'bun:test';
import { FirebaseError } from '../../../src/app/index.js';
import {
  get,
  increment,
  onValue,
  ref,
  runTransaction,
  set,
  TARGET_SYMBOL,
  update,
} from '../../../src/database/index.js';
import { loadObservation as load, setup } from './cdd-replay-helpers.js';

const concurrentObservation = load('rtdb-modular-concurrent-transforms');

describe('RTDB CDD transaction contention cases', () => {
  it('rtdb-modular#157 interleaves concurrent client increments across FIFO microtasks while preserving optimistic local listener delivery', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/increment');
    await set(target, 0);

    const observedLocal: unknown[] = [];
    const unsubscribe = onValue(target, (snap) => {
      observedLocal.push(snap.val());
    });

    const firstWrite = set(target, increment(2));
    expect(observedLocal).toEqual([0, 2]);
    expect(first[TARGET_SYMBOL].backend.adminGet('/contention/increment')).toBe(0);

    const secondWrite = set(ref(second, 'contention/increment'), increment(3));
    expect(first[TARGET_SYMBOL].backend.adminGet('/contention/increment')).toBe(0);

    await Promise.all([firstWrite, secondWrite]);
    unsubscribe();

    expect((await get(target)).val()).toBe(concurrentObservation.incrementTerminal);
    expect(observedLocal.at(-1)).toBe(concurrentObservation.incrementTerminal);

    const updateParentFirst = ref(first, 'contention/update-parent');
    const updateParentSecond = ref(second, 'contention/update-parent');
    await set(ref(first, 'contention/update-parent/increment'), 0);
    await Promise.all([
      update(updateParentFirst, { increment: increment(2) }),
      update(updateParentSecond, { increment: increment(3) }),
    ]);
    expect((await get(ref(first, 'contention/update-parent/increment'))).val()).toBe(
      concurrentObservation.incrementTerminal,
    );
  });

  it('rtdb-modular#161 retries contending concurrent client transactions across FIFO microtasks and rejects at 25 attempts with codeless maxretry', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/transaction');
    await set(target, 0);
    const firstArgs: unknown[] = [];
    const secondArgs: unknown[] = [];
    const results = await Promise.all([
      runTransaction(target, (current) => {
        firstArgs.push(current);
        const base = (current as number | null) ?? 0;
        return base + 1;
      }),
      runTransaction(ref(second, 'contention/transaction'), (current) => {
        secondArgs.push(current);
        const base = (current as number | null) ?? 0;
        return base + 1;
      }),
    ]);
    const warmCountsSorted = [firstArgs.length, secondArgs.length].sort((a, b) => a - b);
    expect(warmCountsSorted).toEqual([1, 2]);
    expect(firstArgs.length > 1 || secondArgs.length > 1).toBe(
      concurrentObservation.retryObserved,
    );
    expect(concurrentObservation.invocationCountsSorted).toEqual([2, 3]);
    expect(results.map((result) => result.committed)).toEqual(concurrentObservation.committed);
    expect(results.map((result) => result.snapshot.val()).sort()).toEqual(
      concurrentObservation.finalSnapshotsSorted,
    );
    expect((await get(target)).val()).toBe(concurrentObservation.transactionTerminal);

    const maxRetryTarget = ref(first, 'contention/maxretry');
    await set(maxRetryTarget, 0);
    let attempts = 0;
    let caught: unknown = null;
    try {
      await runTransaction(maxRetryTarget, (current) => {
        attempts += 1;
        void set(ref(second, 'contention/maxretry'), attempts + 100);
        const base = (current as number | null) ?? 0;
        return base + 1;
      });
    } catch (err) {
      caught = err;
    }
    expect(attempts).toBe(25);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FirebaseError);
    const maxRetryErr = caught as Error & { code?: unknown };
    expect('code' in maxRetryErr).toBe(false);
    expect(maxRetryErr.name).toBe('Error');
    expect(maxRetryErr.message).toBe('maxretry');
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
      const base = (current as number | null) ?? 0;
      return base + 1;
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
      const base = (current as number | null) ?? 0;
      return base + 1;
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
    await runTransaction(ref(first, 'history/transaction'), (current) => {
      const base = (current as number | null) ?? 0;
      return base + 1;
    });
    expect(backend.transactionMutationHistory).toHaveLength(0);
  });
});
