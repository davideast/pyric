/**
 * Realtime Database rule evaluation reuses a read-only view of stored state
 * across reads/listener checks and spine-clones only prioritized ancestor paths
 * rather than deep-cloning untouched branches on every write.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const compiledRulesPath = new URL(
  '../rtdb/compiled-rules.js',
  import.meta.resolve('@pyric/rules/internal'),
).pathname;
const compiledRulesMod = await import(compiledRulesPath);
const realSimulateRtdbRules = compiledRulesMod.simulateRtdbRules as (
  compiled: unknown,
  input: { mockData: Record<string, unknown> },
  options?: unknown,
) => unknown;

const observedMockData: Array<Record<string, unknown>> = [];
mock.module(compiledRulesPath, () => ({
  ...compiledRulesMod,
  simulateRtdbRules: (compiled: unknown, input: { mockData: Record<string, unknown> }, options?: unknown) => {
    observedMockData.push(input.mockData);
    return realSimulateRtdbRules(compiled, input, options);
  },
}));

const { initializeSandbox } = await import('pyric/sandbox');
const {
  getDatabase,
  getAdminDatabase,
  ref,
  get,
  set,
  setWithPriority,
  setPriority,
  update,
  onValue,
  runTransaction,
  sandbox,
} = await import('pyric/database');

beforeEach(() => {
  observedMockData.length = 0;
});

describe('RTDB rules snapshot sharing (Slice D)', () => {
  test('reuses one mockData view across reads and shares untouched subtrees across writes with and without priorities', async () => {
    const box = initializeSandbox();
    const adminDb = getDatabase(box);
    sandbox.setData(adminDb, {
      '/acl/alice': true,
      '/flags/open': true,
      '/cold/archive': { blobA: { nested: 'untouched-1' }, blobB: { nested: 'untouched-2' } },
      '/hot/items/item-0': { count: 0 },
    });
    sandbox.setRules(adminDb, {
      rules: {
        flags: {
          '.read': 'auth != null',
          '.write': "auth != null && root.child('acl').child(auth.uid).val() === true",
        },
        cold: {
          '.read': 'auth != null',
        },
        hot: {
          items: {
            $itemId: {
              '.read': "auth != null && root.child('flags/open').val() === true",
              '.write': "auth != null && root.child('acl').child(auth.uid).val() === true",
              '.validate': "!newData.exists() || (newData.child('count').isNumber() && (root.child('hot/items/item-0').getPriority() === null || root.child('hot/items/item-0').getPriority() >= 0))",
            },
          },
        },
      },
    });

    const aliceDb = getDatabase(box.withAuth({ uid: 'alice' }));
    const bobDb = getDatabase(box.withAuth({ uid: 'bob' }));

    // 1. Repeated reads with no intervening mutation reuse the exact same mockData reference.
    observedMockData.length = 0;
    for (let i = 0; i < 6; i++) {
      const snap = await get(ref(aliceDb, '/hot/items/item-0'));
      expect(snap.val()).toEqual({ count: 0 });
    }
    expect(new Set(observedMockData).size).toBe(1);
    const coldBeforeWrites = observedMockData[0]!.cold;
    expect(coldBeforeWrites).toBeDefined();

    // 2. Writes under `/hot` without priorities do not clone `/cold`.
    observedMockData.length = 0;
    await set(ref(aliceDb, '/hot/items/item-1'), { count: 1 });
    await set(ref(aliceDb, '/hot/items/item-2'), { count: 2 });
    for (const seen of observedMockData) {
      expect(seen.cold).toBe(coldBeforeWrites);
    }

    // 3. Writes with priorities (object + primitive priorities) preserve `.getPriority()` semantics
    //    and STILL share `/cold` without cloning untouched subtrees.
    await setWithPriority(ref(aliceDb, '/hot/items/item-0'), { count: 10 }, 5);
    observedMockData.length = 0;
    await set(ref(aliceDb, '/hot/items/item-1'), { count: 11 });
    expect(observedMockData.length).toBeGreaterThan(0);
    for (const seen of observedMockData) {
      expect(seen.cold).toBe(coldBeforeWrites);
    }

    // Negative priority on item-0 triggers the `.validate` rule reading `root.child(...).getPriority() >= 0`.
    const bypassDb = getAdminDatabase(box);
    await setPriority(ref(bypassDb, '/hot/items/item-0'), -1);
    await expect(set(ref(aliceDb, '/hot/items/item-1'), { count: 12 })).rejects.toThrow(/permission/i);
    await setPriority(ref(bypassDb, '/hot/items/item-0'), 10);

    // Unauthorized writer (`bob` not in `/acl`) is still denied.
    await expect(set(ref(bobDb, '/hot/items/item-1'), { count: 99 })).rejects.toThrow(/permission/i);

    // Multi-path update and transaction preserve rule decisions and untouched subtree sharing.
    observedMockData.length = 0;
    await update(ref(aliceDb, '/hot/items'), {
      'item-1': { count: 21 },
      'item-2': { count: 22 },
    });
    const txRes = await runTransaction(ref(aliceDb, '/hot/items/item-1'), (cur) => ({
      count: ((cur as { count?: number } | null)?.count ?? 0) + 1,
    }));
    expect(txRes.committed).toBe(true);
    expect(txRes.snapshot.val()).toEqual({ count: 22 });
    for (const seen of observedMockData) {
      expect(seen.cold).toBe(coldBeforeWrites);
    }

    // Active listener whose `.read` inspects `root.child('flags/open')` is revoked when `/flags/open` turns false.
    let cancelErr: Error | null = null;
    const unsub = onValue(
      ref(bobDb, '/hot/items/item-1'),
      () => {},
      (err) => { cancelErr = err; },
    );
    expect(cancelErr).toBeNull();
    await set(ref(aliceDb, '/flags/open'), false);
    expect(cancelErr).not.toBeNull();
    expect(cancelErr?.message).toMatch(/permission/i);
    unsub();

    box.dispose();
  });

  test('a pre-write rulesSnapshot never observes post-write mutations, and a rule consumer cannot mutate stored state', async () => {
    const box = initializeSandbox();
    const adminDb = getDatabase(box);
    sandbox.setData(adminDb, {
      '/acl/alice': true,
      '/hot/items/item-0': { count: 0, nested: { tag: 'v0' } },
    });
    sandbox.setRules(adminDb, {
      rules: {
        hot: {
          items: {
            $itemId: {
              '.read': 'auth != null',
              '.write': "auth != null && root.child('acl').child(auth.uid).val() === true",
            },
          },
        },
      },
    });

    const aliceDb = getDatabase(box.withAuth({ uid: 'alice' }));
    const bypassDb = getAdminDatabase(box);

    // 1. Capture pre-write mockData and verify later writes (set, update, priority, transaction)
    //    do NOT mutate any object reachable from that pre-write snapshot.
    observedMockData.length = 0;
    await get(ref(aliceDb, '/hot/items/item-0'));
    const preWriteSnapshot = observedMockData.at(-1)!;
    expect((preWriteSnapshot.hot as { items: Record<string, unknown> }).items['item-0']).toEqual({
      count: 0,
      nested: { tag: 'v0' },
    });

    await set(ref(aliceDb, '/hot/items/item-0'), { count: 50, nested: { tag: 'v1' } });
    await update(ref(aliceDb, '/hot/items'), { 'item-1': { count: 51 } });
    await setWithPriority(ref(bypassDb, '/hot/items/item-0'), { count: 60, nested: { tag: 'v2' } }, 9);
    await runTransaction(ref(aliceDb, '/hot/items/item-0'), () => ({ count: 70, nested: { tag: 'v3' } }));

    // Pre-write snapshot remains frozen at its exact pre-write values:
    expect((preWriteSnapshot.hot as { items: Record<string, unknown> }).items['item-0']).toEqual({
      count: 0,
      nested: { tag: 'v0' },
    });
    expect((preWriteSnapshot.hot as { items: Record<string, unknown> }).items['item-1']).toBeUndefined();

    // 2. Attempting to mutate mockData at root, branch, leaf, or priority-wrapped node throws
    //    and leaves stored RTDB state completely intact.
    observedMockData.length = 0;
    await get(ref(aliceDb, '/hot/items/item-0'));
    const currentView = observedMockData.at(-1)! as Record<string, any>;

    expect(() => { currentView.injected = 123; }).toThrow(TypeError);
    expect(() => { currentView.hot.items['item-0'].count = -999; }).toThrow(TypeError);
    expect(() => { currentView.hot.items['item-0'].nested.tag = 'corrupted'; }).toThrow(TypeError);
    expect(() => { delete currentView.acl.alice; }).toThrow(TypeError);

    const verifySnap = await get(ref(aliceDb, '/hot/items/item-0'));
    expect(verifySnap.val()).toEqual({ count: 70, nested: { tag: 'v3' } });

    box.dispose();
  });
});
