/**
 * RTDB snapshot serialization (#1371, hunt findings RT-6 and RT-7).
 *
 * Expected behavior is upstream `ChildrenNode.val(exportFormat)` in
 * firebase 12.13.0 (`index.node.cjs.js:5513-5544`), run offline by the
 * hunt's `SDK-RT-6-7.mjs`: it walks children in priority, then key order,
 * renders an array only for `val()` (never for `exportVal()` or `toJSON()`),
 * and assigns only the indexes that hold a value, leaving holes. The key
 * order is confirmed in production by `oracle:rtdb-modular-remote-update-event-order`
 * (`valKeys`).
 */
import { describe, expect, it } from 'bun:test';
import {
  get,
  orderByValue,
  query,
  ref,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

const keysOf = (value: unknown) => Object.keys(value as object).join(',');

describe('RT-6: exportVal() and toJSON() keep integer keys; val() leaves holes', () => {
  it('exportVal() and toJSON() return an object for an array-like node', async () => {
    const { db } = setup();
    await set(ref(db, 'r'), { arr: [1, 2, 3] });
    const snap = await get(ref(db, 'r'));
    expect(Array.isArray((snap.val() as { arr: unknown }).arr)).toBe(true);
    expect(snap.exportVal()).toEqual({ arr: { 0: 1, 1: 2, 2: 3 } });
    expect(Array.isArray((snap.exportVal() as { arr: unknown }).arr)).toBe(false);
    expect(Array.isArray((snap.toJSON() as { arr: unknown }).arr)).toBe(false);
  });

  it('exportVal() of an array-like node at the top level is an object', async () => {
    const { db } = setup();
    await set(ref(db, 'list'), ['a', 'b']);
    const snap = await get(ref(db, 'list'));
    expect(snap.val()).toEqual(['a', 'b']);
    expect(Array.isArray(snap.exportVal())).toBe(false);
    expect(snap.exportVal()).toEqual({ 0: 'a', 1: 'b' });
  });

  it('val() leaves a hole where a sparse array has no value', async () => {
    const { db } = setup();
    await set(ref(db, 'r'), { sparse: { 0: 'a', 2: 'c' } });
    const sparse = (await get(ref(db, 'r'))).val() as { sparse: string[] };
    expect(Array.isArray(sparse.sparse)).toBe(true);
    expect(sparse.sparse.length).toBe(3);
    expect(1 in sparse.sparse).toBe(false);
    let visits = 0;
    sparse.sparse.forEach(() => { visits++; });
    expect(visits).toBe(2);
  });

  it('a transaction update function sees holes, as val() does', async () => {
    const { db } = setup();
    await set(ref(db, 'sparse'), { 0: 'a', 2: 'c' });
    let seen: unknown;
    await runTransaction(ref(db, 'sparse'), (current) => {
      seen = current;
      return current;
    });
    expect(Array.isArray(seen)).toBe(true);
    expect(1 in (seen as unknown[])).toBe(false);
  });
});

describe('RT-7: val() keys follow priority, then key order', () => {
  it('a ref snapshot orders keys by key, not by write order', async () => {
    const { db } = setup();
    await set(ref(db, 'o'), { b: 1, a: 3, c: 2 });
    expect(keysOf((await get(ref(db, 'o'))).val())).toBe('a,b,c');
  });

  it('a query snapshot orders keys by key, not by the query order', async () => {
    const { db } = setup();
    await set(ref(db, 'o'), { b: 1, a: 3, c: 2 });
    expect(keysOf((await get(query(ref(db, 'o'), orderByValue()))).val())).toBe('a,b,c');
  });

  it('children with a priority come after children without one, lowest first', async () => {
    const { db } = setup();
    await set(ref(db, 'p'), { a: 1, b: 2, c: 3, d: 4 });
    await setPriority(ref(db, 'p/a'), 9);
    await setPriority(ref(db, 'p/b'), 'x');
    await setPriority(ref(db, 'p/c'), 1);
    const snap = await get(ref(db, 'p'));
    expect(keysOf(snap.val())).toBe('d,c,a,b');
    expect(keysOf(snap.exportVal())).toBe('d,c,a,b');
  });

  it('nested values follow the same order', async () => {
    const { db } = setup();
    await set(ref(db, 'n'), { inner: { z: 1, y: 2 } });
    await setWithPriority(ref(db, 'n/inner/z'), 1, 0);
    const inner = ((await get(ref(db, 'n'))).val() as { inner: object }).inner;
    expect(keysOf(inner)).toBe('y,z');
  });
});
