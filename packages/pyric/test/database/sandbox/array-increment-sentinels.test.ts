import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  increment,
  ref,
  runTransaction,
  sandbox,
  set,
  setWithPriority,
  update,
} from 'pyric/database';

const CAPPED_RULES = {
  rules: {
    items: {
      counters: {
        '.read': true,
        '.write': true,
        $index: {
          '.validate': 'newData.isNumber() && newData.val() <= 10',
        },
      },
      nested: {
        '.read': true,
        '.write': true,
      },
    },
  },
};

const OPEN_RULES = {
  rules: {
    '.read': true,
    '.write': true,
  },
};

describe('RTDB live array increment resolution against canonical DataTree storage', () => {
  test('set() with array increment() resolves against existing elements and enforces .validate cap', async () => {
    const sb = initializeSandbox();
    const db = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
    sandbox.setRules(db, CAPPED_RULES);

    await set(ref(db, 'items/counters'), [10, 10]);

    await expect(
      set(ref(db, 'items/counters'), [increment(5), increment(5)]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect((await get(ref(db, 'items/counters'))).val()).toEqual([10, 10]);

    // Decrementing into range must still resolve against 10 -> [8, 7].
    await set(ref(db, 'items/counters'), [increment(-2), increment(-3)]);
    expect((await get(ref(db, 'items/counters'))).val()).toEqual([8, 7]);
  });

  test('set(), update(), and runTransaction() accumulate array increment() values on stored arrays and prioritized elements', async () => {
    const sb = initializeSandbox();
    const db = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
    sandbox.setRules(db, OPEN_RULES);

    await set(ref(db, 'items/counters'), [10, 20]);
    await set(ref(db, 'items/counters'), [increment(5), increment(3)]);
    expect((await get(ref(db, 'items/counters'))).val()).toEqual([15, 23]);

    // Multi-path update containing an array of increment() sentinels.
    await update(ref(db, 'items'), {
      counters: [increment(2), increment(7)],
    });
    expect((await get(ref(db, 'items/counters'))).val()).toEqual([17, 30]);

    // Prioritized element wrapper on index 0 must still resolve numerically.
    await setWithPriority(ref(db, 'items/counters/0'), 40, 'p0');
    await set(ref(db, 'items/counters'), [increment(5), increment(1)]);
    expect((await get(ref(db, 'items/counters'))).val()).toEqual([45, 31]);

    // Nested arrays inside objects.
    await set(ref(db, 'items/nested'), { matrix: [[3, 4]] });
    await set(ref(db, 'items/nested'), { matrix: [[increment(2), increment(6)]] });
    expect((await get(ref(db, 'items/nested'))).val()).toEqual({ matrix: [[5, 10]] });
  });

  test('runTransaction() returning array increment() enforces .validate against canonical stored elements', async () => {
    const sb = initializeSandbox();
    const db = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
    sandbox.setRules(db, CAPPED_RULES);

    await set(ref(db, 'items/counters'), [9, 8]);

    await expect(
      runTransaction(ref(db, 'items/counters'), () => [increment(5), increment(5)]),
    ).rejects.toThrow(/permission_denied/i);

    expect((await get(ref(db, 'items/counters'))).val()).toEqual([9, 8]);

    const tx = await runTransaction(ref(db, 'items/counters'), () => [increment(1), increment(2)]);
    expect(tx.committed).toBe(true);
    expect(tx.snapshot.val()).toEqual([10, 10]);
  });
});
