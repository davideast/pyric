/** Focused real-Firebase oracle replay: query contracts. */
import { describe, it, expect } from 'bun:test';
import {
  ref,
  get,
  update,
  runTransaction,
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  startAt,
  startAfter,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
} from '../../../src/database/index.js';
import {
  load,
  setup,
  snapKeys,
  snapValues,
} from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): query contracts', () => {
  it('rtdb-modular-orderbychild-window', async () => {
    const obs = load('rtdb-modular-orderbychild-window.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), startAt(2), endAt(4)));
    expect(snapKeys(snap)).toEqual(obs.matchedKeys as string[]); // [b,c,d]
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.positions as number[]); // [2,3,4]
    expect((obs.matchedKeys as string[]).length === 3).toBe(obs.bothEndsInclusive as boolean);
  });

  it('rtdb-modular-orderbykey-window', async () => {
    const obs = load('rtdb-modular-orderbykey-window.json');
    const { db } = setup();
    await update(ref(db, 'letters'), { c: 3, a: 1, e: 5, b: 2, d: 4 });
    const snap = await get(query(ref(db, 'letters'), orderByKey(), startAt('b'), endAt('d')));
    const keys = snapKeys(snap);
    expect(keys).toEqual(obs.matchedKeys as string[]); // [b,c,d]
    expect(keys).toEqual([...keys].sort()); // emitted in key order
    expect(true).toBe(obs.windowInKeyOrder as boolean);
  });

  it('rtdb-modular-orderbyvalue-numeric (KNOWN DIVERGENCE: no `.indexOn` enforcement)', async () => {
    // Prod capture: `query(ref, orderByValue(), limitToFirst(3))` over
    // primitive numeric children THREW — the oracle project lacks the
    // required `.indexOn: ".value"`, so RTDB rejected the query
    // (threw: true, message: "Index not defined, add \".indexOn\"…").
    //
    // The sandbox does NOT enforce `.indexOn` (COMPAT-noted); the same
    // query resolves and returns the 3 smallest values ascending. Pin
    // BOTH sides. (This observation is one of the registry's four
    // `observationExceptions`.)
    const obs = load('rtdb-modular-orderbyvalue-numeric.json');
    expect(obs.threw).toBe(true); // what prod did — index enforcement (the target)
    expect(obs.ascendingFirstThree).toBe(false); // prod couldn't compute the window

    const { db } = setup();
    await update(ref(db, 'scores'), { alice: 30, bob: 10, carol: 50, dave: 20, eve: 40 });
    let threw = false;
    let values: number[] = [];
    let keys: string[] = [];
    try {
      const snap = await get(query(ref(db, 'scores'), orderByValue(), limitToFirst(3)));
      values = snapValues<number>(snap);
      keys = snapKeys(snap);
    } catch {
      threw = true;
    }
    // Sandbox today: no throw, returns the ascending window.
    expect(threw).toBe(false);
    expect(values).toEqual([10, 20, 30]);
    expect(keys).toEqual(['bob', 'dave', 'alice']);
  });

  it('rtdb-modular-query-orderbychild-limit', async () => {
    const obs = load('rtdb-modular-query-orderbychild-limit.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)));
    const ordered = snapKeys(snap).map((key, i) => ({
      key,
      pos: snapValues<{ pos: number }>(snap)[i]!.pos,
    }));
    expect(ordered).toEqual(obs.orderedKeys as Array<{ key: string; pos: number }>); // [{a,1},{b,2}]
    expect(ordered.map((o) => o.pos)).toEqual(obs.positions as number[]); // [1,2]
    expect(ordered.length === 2).toBe(obs.twoResults as boolean);
    expect(true).toBe(obs.firstTwoInOrder as boolean);
  });

  it('rtdb-modular-query-startat-inclusive', async () => {
    const obs = load('rtdb-modular-query-startat-inclusive.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 }, b: { pos: 2 }, c: { pos: 3 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), startAt(2)));
    // startAt is INCLUSIVE — pos===2 is in the result.
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.matched as number[]); // [2,3,4]
    expect((obs.matched as number[]).includes(2)).toBe(obs.cursorInclusive as boolean);
  });

  it('rtdb-modular-startafter-endbefore-exclusive', async () => {
    const obs = load('rtdb-modular-startafter-endbefore-exclusive.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 }, b: { pos: 2 }, c: { pos: 3 }, d: { pos: 4 }, e: { pos: 5 },
    });
    const snap = await get(
      query(ref(db, 'list'), orderByChild('pos'), startAfter(2), endBefore(5)),
    );
    // startAfter + endBefore drop the boundary values (2 and 5).
    expect(snapKeys(snap)).toEqual(obs.matchedKeys as string[]); // [c,d]
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.positions as number[]); // [3,4]
    expect(!(obs.positions as number[]).includes(2) && !(obs.positions as number[]).includes(5)).toBe(
      obs.bothExclusive as boolean,
    );
  });

  it('rtdb-modular-limittofirst-vs-limittolast', async () => {
    const obs = load('rtdb-modular-limittofirst-vs-limittolast.json');
    const { db } = setup();
    const seed = { c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 } };
    await update(ref(db, 'list'), seed);
    const first = await get(query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)));
    const last = await get(query(ref(db, 'list'), orderByChild('pos'), limitToLast(2)));
    expect(snapKeys(first)).toEqual(obs.firstKeys as string[]); // [a,b]
    expect(snapValues<{ pos: number }>(first).map((v) => v.pos)).toEqual(obs.firstPositions as number[]); // [1,2]
    expect(snapKeys(last)).toEqual(obs.lastKeys as string[]); // [d,e]
    expect(snapValues<{ pos: number }>(last).map((v) => v.pos)).toEqual(obs.lastPositions as number[]); // [4,5]
    expect(true).toBe(obs.firstTakesLowest as boolean);
    expect(true).toBe(obs.lastTakesHighest as boolean);
  });

  it('rtdb-modular-equalTo-filter', async () => {
    const obs = load('rtdb-modular-equalTo-filter.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      k1: { group: 'a' }, k2: { group: 'b' }, k3: { group: 'c' }, k4: { group: 'b' }, k5: { group: 'a' },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('group'), equalTo('b')));
    // RTDB does NOT enforce uniqueness — both 'b'-grouped children come back.
    expect(snapKeys(snap).sort()).toEqual(obs.matchedKeys as string[]); // [k2,k4]
    expect(snapValues<{ group: string }>(snap).map((v) => v.group)).toEqual(obs.groups as string[]); // [b,b]
    expect(true).toBe(obs.onlyBMatched as boolean);
  });

  it('rtdb-modular-query-equalto', async () => {
    const obs = load('rtdb-modular-query-equalto.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      k1: { group: 'red' }, k2: { group: 'blue' }, k3: { group: 'blue' }, k4: { group: 'green' },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('group'), equalTo('blue')));
    expect(snapKeys(snap).sort()).toEqual(obs.matchedKeys as string[]); // [k2,k3]
    expect(true).toBe(obs.onlyBlueMatched as boolean);
  });

  // ── runTransaction ───────────────────────────────────────────────────

});
