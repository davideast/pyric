/**
 * Upstream-mined modular RTDB probes (series PR 3).
 *
 * Sourced from firebase-js-sdk `packages/database-compat/test/query.test.ts`
 * (+ order_by suites), rewritten as modular free functions against claimed
 * COMPAT rows:
 *   R1. Int-key windows + INT32 overflow/underflow — M50
 *   R4. Parent wipe → `child_removed` fan-out — M45
 *   R2. Deep `orderByChild('a/b')` + limit — M36 / M49
 *   R5. Multipath `update` vs limited query window — M15 / M58
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  endBefore,
  get,
  getDatabase,
  limitToFirst,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByKey,
  query,
  ref,
  remove,
  set,
  startAfter,
  update,
  type DataSnapshot,
  sandbox as databaseSandbox,
} from '../../src/database/index.js';

const INTEGER_32_MAX = 2147483647;
const INTEGER_32_MIN = -2147483648;

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setDefaultPolicy(db, 'allow');
  return { sandbox, db };
}

function snapKeys(snap: DataSnapshot): string[] {
  const out: string[] = [];
  snap.forEach((child) => {
    if (child.key) out.push(child.key);
    return false;
  });
  return out;
}

describe('R1 int-key INT32 overflow/underflow (upstream RTDB probes)', () => {
  it('startAfter(INT32_MAX) yields only non-integer keys', async () => {
    const { db } = setup();
    await set(ref(db, 'col'), {
      1: true,
      50: true,
      550: true,
      6: true,
      600: true,
      70: true,
      8: true,
      80: true,
      a: true,
    });
    const snap = await get(
      query(ref(db, 'col'), orderByKey(), startAfter(String(INTEGER_32_MAX))),
    );
    expect(snap.val()).toEqual({ a: true });
  });

  it('endBefore(INT32_MIN) yields an empty snapshot', async () => {
    const { db } = setup();
    await set(ref(db, 'one'), { 1: true });
    const snap = await get(
      query(ref(db, 'one'), orderByKey(), endBefore(String(INTEGER_32_MIN))),
    );
    expect(snap.val()).toBeNull();
  });
});

describe('R4 parent wipe child_removed fan-out (upstream RTDB probes)', () => {
  it('remove(parent) fans out child_removed for every direct child with prior vals', async () => {
    const { db } = setup();
    await set(ref(db, 'p'), { k1: 1, k2: 2, k3: 3 });
    const removed: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildRemoved(ref(db, 'p'), (snap) => {
      removed.push({ key: snap.key, val: snap.val() });
    });
    await remove(ref(db, 'p'));
    expect(removed).toEqual([
      { key: 'k1', val: 1 },
      { key: 'k2', val: 2 },
      { key: 'k3', val: 3 },
    ]);
    unsub();
  });

  it('set(parent, scalar) fans out child_removed for every prior direct child', async () => {
    const { db } = setup();
    await set(ref(db, 'p2'), { a: 1, b: 2 });
    const keys: string[] = [];
    const unsub = onChildRemoved(ref(db, 'p2'), (snap) => {
      if (snap.key) keys.push(snap.key);
    });
    await set(ref(db, 'p2'), 'scalar');
    expect(keys).toEqual(['a', 'b']);
    unsub();
  });
});

describe('R2 deep orderByChild (upstream RTDB probes)', () => {
  it("orderByChild('a/b') + limitToFirst orders by the nested path", async () => {
    const { db } = setup();
    await set(ref(db, 'items'), {
      x: { a: { b: 3 } },
      y: { a: { b: 1 } },
      z: { a: { b: 2 } },
    });
    const snap = await get(
      query(ref(db, 'items'), orderByChild('a/b'), limitToFirst(2)),
    );
    expect(snapKeys(snap)).toEqual(['y', 'z']);
  });
});

describe('R5 multipath update vs limited query window (upstream RTDB probes)', () => {
  it('one update nulls, mutates, and displaces within a limitToFirst window', async () => {
    const { db } = setup();
    await set(ref(db, 'list'), {
      a: { pos: 1 },
      b: { pos: 2 },
      c: { pos: 3 },
      d: { pos: 4 },
    });
    const fires: string[][] = [];
    const q = query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2));
    const unsub = onValue(q, (snap) => {
      fires.push(snapKeys(snap));
    });
    expect(fires).toEqual([['a', 'b']]);

    // Atomic multipath: drop `a`, push `b` out of the window, bring `z` in.
    await update(ref(db, 'list'), {
      a: null,
      'b/pos': 5,
      z: { pos: 0 },
    });
    expect(fires).toEqual([
      ['a', 'b'],
      ['z', 'c'],
    ]);
    unsub();
  });
});
