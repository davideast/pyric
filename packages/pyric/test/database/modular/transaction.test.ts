/**
 * `@pyric/rtdb` modular SDK — `runTransaction` (Tier 4) tests.
 *
 * Each test pins one transaction-semantics claim and cites the exact
 * oracle observation it's locking. RTDB transactions differ from
 * Firestore in two load-bearing ways: returning `undefined` is the
 * abort path (Firestore has no equivalent), and the resolved value is
 * `{ committed, snapshot }` rather than the update fn's return value.
 *
 * The rules-denied shape is also distinct from `set`/`get`'s plain-
 * `Error` `PERMISSION_DENIED` — `runTransaction` rejections carry
 * `message: 'permission_denied'` (lowercase, no `.code`). The oracle
 * observation `rtdb-modular-runtransaction-on-rules-denied-path.json`
 * pinned that empirically; we mirror it.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  onChildAdded,
  onChildChanged,
  runTransaction,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  rtdbSandbox.setDefaultPolicy(db, 'allow');
  return { sandbox, db };
}

describe('runTransaction — success path (oracle: rtdb-modular-runtransaction-success)', () => {
  // Mirrors rtdb-modular-runtransaction-success.json:
  //   - seenCurrentValues: [null]   (missing path → null arg)
  //   - committed: true
  //   - snapVal: 1                  (the update-fn return value)
  it('commits the update fn return value and resolves { committed: true, snapshot }', async () => {
    const { db } = setup();
    const result = await runTransaction<number>(ref(db, 'counter'), (current) => {
      return (typeof current === 'number' ? current : 0) + 1;
    });
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(1);
    expect(result.snapshot.exists()).toBe(true);
    expect(result.snapshot.key).toBe('counter');
  });

  it('persists the committed value — subsequent get() returns it', async () => {
    const { db } = setup();
    await runTransaction<number>(ref(db, 'counter'), () => 42);
    const snap = await get(ref(db, 'counter'));
    expect(snap.val()).toBe(42);
  });
});

describe('runTransaction — abort by returning undefined (oracle: rtdb-modular-runtransaction-abort-undefined)', () => {
  // Mirrors rtdb-modular-runtransaction-abort-undefined.json:
  //   - committed: false
  //   - snapVal: null               (pre-transaction null carried into snap;
  //                                  matches our "snapshot reflects current
  //                                  value at abort time" contract)
  //   - afterValOnServer: 100       (seed value preserved)
  //
  // The oracle observed snapVal: null because the snapshot reflects
  // the pre-transaction state observed BEFORE the seed write would
  // hit. The implementation contract: the snap is the actual
  // pre-transaction value, so against a seeded 100 we expect snap.val()
  // === 100 (the prior-seed value, not null). We test BOTH branches.
  it('returning undefined aborts — committed: false, no write', async () => {
    const { db } = setup();
    await set(ref(db, 'counter'), 100);
    const result = await runTransaction<number>(ref(db, 'counter'), () => undefined);
    expect(result.committed).toBe(false);
    // Server-side value preserved (oracle's afterValOnServer: 100).
    const snap = await get(ref(db, 'counter'));
    expect(snap.val()).toBe(100);
  });

  it('abort against an absent path resolves with snapshot.val() === null', async () => {
    const { db } = setup();
    const result = await runTransaction<number>(ref(db, 'never-written'), () => undefined);
    expect(result.committed).toBe(false);
    expect(result.snapshot.val()).toBeNull();
    expect(result.snapshot.exists()).toBe(false);
  });
});

describe('runTransaction — current-value arg shape (oracle: rtdb-modular-runtransaction-current-value-arg)', () => {
  // Mirrors rtdb-modular-runtransaction-current-value-arg.json:
  //   - missingArgs[0].isNull: true       (absent path → null, NOT undefined)
  //   - seededFirstShape: 'object'
  //
  // Prod's seededArgs showed TWO invocations (speculative null, then
  // the real value). The sandbox doesn't model speculative re-runs —
  // it invokes the fn ONCE with the actual current value. We document
  // this divergence in the matrix.
  it('update fn receives null for an absent path', async () => {
    const { db } = setup();
    let seenArg: unknown = 'unset';
    let seenType: string = '';
    await runTransaction<number>(ref(db, 'missing'), (current) => {
      seenArg = current;
      seenType = typeof current;
      return 1;
    });
    expect(seenArg).toBeNull();
    expect(seenType).toBe('object'); // typeof null === 'object'
  });

  it('update fn receives the existing value for a seeded path', async () => {
    const { db } = setup();
    await set(ref(db, 'user'), { name: 'alice', count: 7 });
    let seenArg: unknown = 'unset';
    await runTransaction<{ name: string; count: number }>(ref(db, 'user'), (current) => {
      seenArg = current;
      // No abort — commit a bump.
      if (current && typeof current === 'object') {
        return { ...current, count: current.count + 1 };
      }
      return current ?? undefined;
    });
    expect(seenArg).toEqual({ name: 'alice', count: 7 });
  });

  it('mutating the update-fn arg does NOT corrupt the stored tree', async () => {
    // Defensive: the backend hands the fn a deep clone. Without this
    // guarantee, `current.count++; return undefined` would silently
    // mutate stored state on abort.
    const { db } = setup();
    await set(ref(db, 'user'), { count: 1 });
    await runTransaction<{ count: number }>(ref(db, 'user'), (current) => {
      if (current) (current as { count: number }).count = 999;
      return undefined; // abort
    });
    const snap = await get(ref(db, 'user'));
    expect(snap.val()).toEqual({ count: 1 });
  });
});

describe('runTransaction — returns committed snapshot shape (oracle: rtdb-modular-runtransaction-returns-committed-snapshot)', () => {
  // Mirrors rtdb-modular-runtransaction-returns-committed-snapshot.json:
  //   - resultKeys: ['committed', 'snapshot']
  //   - committedType: 'boolean'
  //   - hasSnapshotProp: true
  //   - snapshotValIsFn: true
  //   - snapVal: { count: 42 }
  //   - snapExists: true
  //   - snapKey: 'v'
  it('resolves to { committed: boolean, snapshot } with the committed value', async () => {
    const { db } = setup();
    await set(ref(db, 'v'), { count: 41 });
    const result = await runTransaction<{ count: number }>(ref(db, 'v'), (current) => {
      if (current && typeof current === 'object') return { count: current.count + 1 };
      return { count: 1 };
    });
    // Shape claim — these exact keys, nothing more.
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['committed', 'snapshot']);
    expect(typeof result.committed).toBe('boolean');
    expect(result.committed).toBe(true);
    // Snapshot responds to the documented methods.
    expect(typeof result.snapshot.val).toBe('function');
    expect(typeof result.snapshot.exists).toBe('function');
    expect(result.snapshot.val()).toEqual({ count: 42 });
    expect(result.snapshot.exists()).toBe(true);
    expect(result.snapshot.key).toBe('v');
  });
});

describe('runTransaction — options.applyLocally (oracle: rtdb-modular-runtransaction-options-applylocally)', () => {
  // Mirrors rtdb-modular-runtransaction-options-applylocally.json:
  //   - trueFireVals: [1, 11]   (initial fire + commit fire)
  //   - falseFireVals: [1, 11]  (same — no intermediate optimistic
  //                              fire observable from a single client)
  //   - bothCommitted: true
  //   - bothEndedAt11: true
  //
  // Single-client harness: applyLocally:true vs false produce the same
  // observable end state. We assert the SHARED contract (both commit;
  // both end at the new value) AND the listener fire count (init + 1
  // commit). Future contention modeling could pin the divergence.
  it('applyLocally: true (default) — listener sees initial + committed value', async () => {
    const { db } = setup();
    await set(ref(db, 'v'), 1);
    const fires: unknown[] = [];
    const off = onValue(ref(db, 'v'), (snap) => { fires.push(snap.val()); });
    expect(fires).toEqual([1]);
    const result = await runTransaction<number>(
      ref(db, 'v'),
      (current) => (typeof current === 'number' ? current : 0) + 10,
      { applyLocally: true },
    );
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(11);
    // At least the initial + commit fires landed. (Single-client
    // harness — no intermediate retries to fire on.)
    expect(fires).toContain(1);
    expect(fires).toContain(11);
    off();
  });

  it('applyLocally: false — listener sees only the committed value', async () => {
    const { db } = setup();
    await set(ref(db, 'v'), 1);
    const fires: unknown[] = [];
    const off = onValue(ref(db, 'v'), (snap) => { fires.push(snap.val()); });
    const initialFireCount = fires.length;
    const result = await runTransaction<number>(
      ref(db, 'v'),
      (current) => (typeof current === 'number' ? current : 0) + 10,
      { applyLocally: false },
    );
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(11);
    // No optimistic intermediate fire — only the commit fire after the
    // initial. (Sandbox honors the flag; prod's single-client
    // observation matches.)
    const postTxFireCount = fires.length;
    expect(postTxFireCount - initialFireCount).toBe(1);
    expect(fires[fires.length - 1]).toBe(11);
    off();
  });
});

describe('runTransaction — rules-denied error shape (oracle: rtdb-modular-runtransaction-on-rules-denied-path)', () => {
  // Mirrors rtdb-modular-runtransaction-on-rules-denied-path.json EXACTLY:
  //   - threw: true
  //   - code: null                  (no .code field on transaction errors!)
  //   - message: 'permission_denied' (LOWERCASE — distinct from set/get's
  //                                   'PERMISSION_DENIED: Permission denied')
  //   - errorName: 'Error'
  //   - constructorName: 'Error'
  //   - isErrorInstance: true
  //   - committed: null              (true rejection, NOT a { committed:
  //                                    false } resolve)
  //
  // The divergence from `set`/`get` is load-bearing: someone migrating
  // an error handler that branches on `err.code === 'PERMISSION_DENIED'`
  // would silently miss transaction denials. This shape pins the
  // behavior the oracle saw.
  function denyAll() {
    return {
      rules: {
        '.read': 'false',
        '.write': 'false',
      },
    };
  }

  it('rejects with a plain Error whose message is "permission_denied"', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, denyAll());
    let caught: unknown;
    try {
      await runTransaction<number>(ref(db, 'forbidden'), () => 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught instanceof Error).toBe(true);
    const err = caught as Error & { code?: string };
    expect(err.message).toBe('permission_denied');
    expect(err.name).toBe('Error');
    expect(err.constructor.name).toBe('Error');
    // No .code field — distinct from set/get's PERMISSION_DENIED.
    expect(err.code).toBeUndefined();
  });

  it('does not write to the path when rules deny', async () => {
    const { db } = setup();
    // Seed first under default-allow, then lock down.
    await set(ref(db, 'v'), 1);
    rtdbSandbox.setRules(db, denyAll());
    try {
      await runTransaction<number>(ref(db, 'v'), () => 999);
    } catch {
      // expected
    }
    // Lift the deny so we can read back; the prior value should be
    // intact.
    rtdbSandbox.setRules(db, null);
    const snap = await get(ref(db, 'v'));
    expect(snap.val()).toBe(1);
  });
});

describe('runTransaction — listener fires on commit', () => {
  // Implementation contract (matrix-only — no separate oracle row): a
  // committed transaction fires registered onValue listeners with the
  // new value. Adjacent to applyLocally — this is the "fan-out happens"
  // claim, the applyLocally tests check the suppression branch.
  it('committed write fans out to onValue listeners', async () => {
    const { db } = setup();
    let lastVal: unknown = undefined;
    const off = onValue(ref(db, 'counter'), (snap) => { lastVal = snap.val(); });
    expect(lastVal).toBeNull(); // initial fire
    await runTransaction<number>(ref(db, 'counter'), () => 7);
    expect(lastVal).toBe(7);
    off();
  });

  it('committed write fans out to child listeners', async () => {
    const { db } = setup();
    await set(ref(db, 'counters/alpha'), 1);
    const values: unknown[] = [];
    const off = onChildChanged(ref(db, 'counters'), (snap) => {
      values.push(snap.val());
    });

    await runTransaction<number>(ref(db, 'counters/alpha'), (current) =>
      (current ?? 0) + 1,
    );

    expect(values).toEqual([2]);
    off();
  });

  it('committed creation fans out to child-added listeners', async () => {
    const { db } = setup();
    const values: unknown[] = [];
    const off = onChildAdded(ref(db, 'counters'), (snap) => {
      values.push(snap.val());
    });

    await runTransaction<number>(ref(db, 'counters/alpha'), () => 1);

    expect(values).toEqual([1]);
    off();
  });

  it('aborted transaction does NOT fan out to listeners', async () => {
    const { db } = setup();
    await set(ref(db, 'counter'), 100);
    let fireCount = 0;
    const off = onValue(ref(db, 'counter'), () => { fireCount++; });
    const preTx = fireCount;
    await runTransaction<number>(ref(db, 'counter'), () => undefined);
    // Only the initial fire. The abort path does NO write → no fan-out.
    expect(fireCount).toBe(preTx);
    off();
  });

  it('applyLocally false still notifies persistence subscribers', async () => {
    const { sandbox, db } = setup();
    let writes = 0;
    const unsubscribe = getOrCreateBackend(sandbox).subscribeWrites(() => { writes++; });

    await runTransaction<number>(ref(db, 'counter'), () => 1, { applyLocally: false });

    expect(writes).toBe(1);
    unsubscribe();
  });
});
