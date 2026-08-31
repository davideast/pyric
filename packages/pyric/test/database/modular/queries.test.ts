/**
 * `@pyric/rtdb` modular SDK — Tier 3 (queries) tests.
 *
 * Each test cites the specific oracle observation under
 * `packages/conformance/observations/` (and the matrix row in
 * `packages/rtdb/COMPAT.md`) that it locks. The link from test →
 * observation is the conformance contract — if you change the test
 * expectation, run the matching probe and update the observation file
 * first.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  get,
  onValue,
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  orderByPriority,
  setPriority,
  setWithPriority,
  startAt,
  startAfter,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
  type DataSnapshot,
  type DatabaseReference,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

/** Collect the matched keys (in iteration order) from a snapshot. */
function snapKeys(snap: DataSnapshot): string[] {
  const out: string[] = [];
  snap.forEach((child) => {
    if (child.key) out.push(child.key);
    return false;
  });
  return out;
}

/** Collect the values (in iteration order) from a snapshot. */
function snapValues<T = unknown>(snap: DataSnapshot): T[] {
  const out: T[] = [];
  snap.forEach((child) => {
    out.push(child.val() as T);
    return false;
  });
  return out;
}

describe('query(ref, orderByChild, startAt, endAt) — both-inclusive window (oracle: rtdb-modular-orderbychild-window)', () => {
  // Matrix row #142/#146/#147. Oracle observation:
  //   matchedKeys: ['b','c','d'], positions: [2,3,4], bothEndsInclusive: true.
  it('returns children whose ordered child is within [startAt, endAt] inclusive', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 },
      a: { pos: 1 },
      e: { pos: 5 },
      b: { pos: 2 },
      d: { pos: 4 },
    });
    const q = query(ref(db, 'list'), orderByChild('pos'), startAt(2), endAt(4));
    const snap = await get(q);
    expect(snapKeys(snap)).toEqual(['b', 'c', 'd']);
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual([2, 3, 4]);
  });

  it('forEach visits children in ascending order of the child key', async () => {
    const { db } = setup();
    // Insert in shuffled order; the executor must still emit by ordered value.
    await update(ref(db, 'list'), {
      z: { pos: 9 },
      m: { pos: 1 },
      x: { pos: 5 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos')));
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual([1, 5, 9]);
  });
});

describe('query(ref, orderByKey, startAt, endAt) — key-window (oracle: rtdb-modular-orderbykey-window)', () => {
  // Matrix row #143/#146/#147. Oracle observation:
  //   matchedKeys: ['b','c','d'], windowInKeyOrder: true.
  it('orderByKey + startAt(s) + endAt(e) yields keys in [s,e] inclusive, in key order', async () => {
    const { db } = setup();
    await update(ref(db, 'letters'), { c: 3, a: 1, e: 5, b: 2, d: 4 });
    const q = query(ref(db, 'letters'), orderByKey(), startAt('b'), endAt('d'));
    const snap = await get(q);
    expect(snapKeys(snap)).toEqual(['b', 'c', 'd']);
  });
});

describe('query(ref, orderByValue, limitToFirst) — primitive children (oracle: rtdb-modular-orderbyvalue-numeric)', () => {
  // Matrix row #144/#150. Oracle observation: prod threw `Index not defined`
  // (sandbox doesn't enforce indexes — see COMPAT note). Semantic claim
  // locked here: the executor returns the 3 smallest values in ascending
  // order.
  it('returns the limitToFirst(N) smallest values, ascending', async () => {
    const { db } = setup();
    await update(ref(db, 'scores'), {
      alice: 30,
      bob: 10,
      carol: 50,
      dave: 20,
      eve: 40,
    });
    const q = query(ref(db, 'scores'), orderByValue(), limitToFirst(3));
    const snap = await get(q);
    expect(snapValues<number>(snap)).toEqual([10, 20, 30]);
    expect(snapKeys(snap)).toEqual(['bob', 'dave', 'alice']);
  });
});

describe('query(ref, orderByChild, equalTo) — exact-match filter (oracle: rtdb-modular-equalTo-filter)', () => {
  // Matrix row #145. Oracle observation: matchedKeys ['k2','k4'],
  // groups ['b','b'], onlyBMatched: true. RTDB does NOT enforce
  // uniqueness — both 'b'-grouped children come back.
  it('returns ALL children whose ordered field === the supplied value', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      k1: { group: 'a' },
      k2: { group: 'b' },
      k3: { group: 'c' },
      k4: { group: 'b' },
      k5: { group: 'a' },
    });
    const q = query(ref(db, 'list'), orderByChild('group'), equalTo('b'));
    const snap = await get(q);
    expect(snapKeys(snap).sort()).toEqual(['k2', 'k4']);
    expect(snapValues<{ group: string }>(snap).map((v) => v.group)).toEqual(['b', 'b']);
  });

  it('returns an empty snapshot when nothing matches', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), { k1: { group: 'a' } });
    const snap = await get(query(ref(db, 'list'), orderByChild('group'), equalTo('z')));
    expect(snap.exists()).toBe(false);
    expect(snap.size).toBe(0);
    expect(snapKeys(snap)).toEqual([]);
  });
});

describe('query(ref, …, limitToFirst vs limitToLast) — window from either end (oracle: rtdb-modular-limittofirst-vs-limittolast)', () => {
  // Matrix row #150/#151. Oracle observation:
  //   firstKeys ['a','b'] (positions [1,2]); lastKeys ['d','e'] (positions [4,5]).
  it('limitToFirst takes the lowest-ranked window', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 },
      a: { pos: 1 },
      e: { pos: 5 },
      b: { pos: 2 },
      d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)));
    expect(snapKeys(snap)).toEqual(['a', 'b']);
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual([1, 2]);
  });

  it('limitToLast takes the highest-ranked window', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 },
      a: { pos: 1 },
      e: { pos: 5 },
      b: { pos: 2 },
      d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), limitToLast(2)));
    expect(snapKeys(snap)).toEqual(['d', 'e']);
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual([4, 5]);
  });

  it('limitToFirst(N) larger than the result returns the full window', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), { a: 1, b: 2 });
    const snap = await get(query(ref(db, 'list'), orderByKey(), limitToFirst(10)));
    expect(snapKeys(snap)).toEqual(['a', 'b']);
  });
});

describe('query(ref, …, startAfter, endBefore) — exclusive cursors (oracle: rtdb-modular-startafter-endbefore-exclusive)', () => {
  // Matrix row #148/#149. Oracle observation:
  //   positions [3,4], bothExclusive: true (cursors 2 and 5 dropped).
  it('startAfter + endBefore drop the boundary values', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 },
      b: { pos: 2 },
      c: { pos: 3 },
      d: { pos: 4 },
      e: { pos: 5 },
    });
    const q = query(
      ref(db, 'list'),
      orderByChild('pos'),
      startAfter(2),
      endBefore(5),
    );
    const snap = await get(q);
    expect(snapKeys(snap)).toEqual(['c', 'd']);
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual([3, 4]);
  });
});

describe('onValue(query) — windowed listener (oracle: rtdb-modular-onvalue-with-query)', () => {
  // Matrix row #152. Oracle observation: fireCount: 3
  //   1) Initial fire with [a,b].
  //   2) Write to 'c/extra' (OUTSIDE window) — no fire.
  //   3) Write to 'a' (INSIDE window, value changed) — re-fire with [a,b].
  //   4) Write to 'z' (enters window, displacing 'b') — re-fire with [z,a].
  it('fires only when the windowed result changes', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 },
      b: { pos: 2 },
      c: { pos: 3 },
    });
    const fires: Array<{ keys: string[]; positions: number[] }> = [];
    const q = query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2));
    const off = onValue(q, (snap) => {
      const keys: string[] = [];
      const positions: number[] = [];
      snap.forEach((child) => {
        if (child.key) keys.push(child.key);
        const v = child.val() as { pos: number } | null;
        if (v) positions.push(v.pos);
        return false;
      });
      fires.push({ keys, positions });
    });
    // 1) initial fire — done above synchronously.
    expect(fires.length).toBe(1);
    expect(fires[0]!.keys).toEqual(['a', 'b']);
    // 2) write to 'c' (OUTSIDE window) — should NOT fire.
    await set(ref(db, 'list/c/extra'), 1);
    expect(fires.length).toBe(1);
    // 3) write to 'a' (INSIDE window, value changed) — SHOULD fire.
    await set(ref(db, 'list/a'), { pos: 1, label: 'A!' });
    expect(fires.length).toBe(2);
    expect(fires[1]!.keys).toEqual(['a', 'b']);
    // 4) write to 'z' (enters window, displaces 'b') — SHOULD fire.
    await set(ref(db, 'list/z'), { pos: 0 });
    expect(fires.length).toBe(3);
    expect(fires[2]!.keys).toEqual(['z', 'a']);
    off();
    // Verifies the unsubscribe — should NOT fire after off().
    await set(ref(db, 'list/z'), { pos: 0, more: true });
    expect(fires.length).toBe(3);
  });

  it('initial fire on an empty path delivers an empty window', async () => {
    const { db } = setup();
    const fires: number[] = [];
    const off = onValue(
      query(ref(db, 'missing'), orderByChild('pos'), limitToFirst(2)),
      (snap) => {
        fires.push(snap.size);
      },
    );
    expect(fires).toEqual([0]);
    off();
  });

  it('preserves query order for integer-looking keys in listener snapshots', async () => {
    const { db } = setup();
    const target = ref(db, 'numeric-keys');
    await set(target, { '1': { rank: 2 }, '2': { rank: 1 } });
    const deliveries: string[][] = [];
    const unsubscribe = onValue(query(target, orderByChild('rank')), (snap) => {
      deliveries.push(snapKeys(snap));
    });
    expect(deliveries).toEqual([['2', '1']]);
    unsubscribe();
  });

  it('re-fires a priority query when setPriority changes its ordered window', async () => {
    const { db } = setup();
    const target = ref(db, 'priority-listener');
    await setWithPriority(ref(db, 'priority-listener/a'), 1, 10);
    await setWithPriority(ref(db, 'priority-listener/b'), 2, 5);
    const deliveries: string[][] = [];
    const unsubscribe = onValue(query(target, orderByPriority()), (snap) => {
      deliveries.push(snapKeys(snap));
    });
    await setPriority(ref(db, 'priority-listener/a'), 0);
    expect(deliveries).toEqual([['b', 'a'], ['a', 'b']]);
    unsubscribe();
  });
});

describe('query chaining + introspection', () => {
  // Locks the public `Query` shape — chaining + the `ref` accessor used
  // by app code for "drill into the underlying location" idioms.
  it('query(query(ref, c1), c2) composes constraints', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 },
      b: { pos: 2 },
      c: { pos: 3 },
      d: { pos: 4 },
    });
    const base = query(ref(db, 'list'), orderByChild('pos'));
    const limited = query(base, limitToFirst(2));
    const snap = await get(limited);
    expect(snapKeys(snap)).toEqual(['a', 'b']);
  });

  it('Query exposes the underlying ref', () => {
    const { db } = setup();
    const q = query(ref(db, 'list'), orderByKey());
    expect(q.ref._path).toBe('/list');
  });

  it('Query.toString() returns the ref URL', () => {
    const { db } = setup();
    const q = query(ref(db, 'list'), orderByKey());
    expect(q.toString()).toBe('sandbox://rtdb/list');
  });
});

describe('query — degenerate inputs', () => {
  // Locks executor behavior at the edges; no oracle observation (these
  // are sandbox-only invariants).
  it('query on a path with primitive value returns no rows', async () => {
    const { db } = setup();
    await set(ref(db, 'leaf'), 42);
    const snap = await get(query(ref(db, 'leaf'), orderByKey()));
    expect(snap.size).toBe(0);
  });

  it('query with no constraints behaves like a plain get (default priority index)', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), { c: 3, a: 1, b: 2 });
    const snap = await get(query(ref(db, 'list')));
    expect(snapKeys(snap)).toEqual(['a', 'b', 'c']);
  });

  it('startAt with key tie-breaker drops earlier same-value children', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 },
      b: { pos: 1 },
      c: { pos: 1 },
      d: { pos: 1 },
    });
    // All children share pos=1; the tie-breaker key picks the slice
    // starting at 'c'. Inclusive boundary semantics.
    const q = query(ref(db, 'list'), orderByChild('pos'), startAt(1, 'c'));
    const snap = await get(q);
    expect(snapKeys(snap)).toEqual(['c', 'd']);
  });

  it('orderByChild on a missing child path treats those children as null (sorts first)', async () => {
    const { db } = setup();
    await update(ref(db, 'list'), {
      withField: { pos: 5 },
      withoutField: { other: 'x' },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos')));
    // null sorts before number → 'withoutField' comes first.
    expect(snapKeys(snap)).toEqual(['withoutField', 'withField']);
  });
});

describe('query — push + read-back ordering', () => {
  // Lex-sortable push IDs interact with orderByKey to give chronological
  // order. This is the bread-and-butter "tail of a feed" pattern.
  it('orderByKey + limitToLast(N) returns the N most-recent pushed children', async () => {
    const { db } = setup();
    const feed = ref(db, 'feed');
    const r1 = push(feed, { msg: 'one' });
    const r2 = push(feed, { msg: 'two' });
    const r3 = push(feed, { msg: 'three' });
    const snap = await get(query(feed, orderByKey(), limitToLast(2)));
    const keys = snapKeys(snap);
    expect(keys).toEqual([r2.key!, r3.key!]);
    // sanity-check r1 didn't leak in:
    expect(keys).not.toContain(r1.key);
  });
});

describe('listenerCount + query integration (no leaks)', () => {
  it('query listener unsubscribes cleanly', () => {
    const { db } = setup();
    // Plain `onValue` doesn't expose a listener count on the SDK
    // surface — but we can observe via post-off behavior: writes don't
    // fire the cb after off().
    let fires = 0;
    const off = onValue(
      query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)),
      () => { fires++; },
    );
    expect(fires).toBe(1);
    off();
    // Trigger a write that WOULD have fired if still subscribed.
    void set(ref(db, 'list/a'), { pos: 1 });
    // No additional fires.
    expect(fires).toBe(1);
  });
});

describe('query — DatabaseReference identity preserved', () => {
  it('query.ref points to the original ref (same path)', () => {
    const { db } = setup();
    const r: DatabaseReference = ref(db, 'list');
    const q = query(r, orderByKey());
    expect(q.ref._path).toBe(r._path);
  });
});
