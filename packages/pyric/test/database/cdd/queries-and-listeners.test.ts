import { describe, expect, it } from 'bun:test';
import {
  api,
  assertChildEvent,
  assertSnapshotShape,
  assertValueListener,
  keys,
  queryKeys,
  setup,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

const valueIndexObservation = loadObservation('rtdb-modular-orderbyvalue-numeric');

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: query, normalization, and listener rows', () => {
  row('M49', async () => expect(await queryKeys([api.orderByChild('score'), api.startAt(2), api.endAt(3)])).toEqual(['b', 'c']));
  row('M50', async () => expect(await queryKeys([api.orderByKey()], { '10': true, '2': true, '1': true, z: true })).toEqual(['1', '2', '10', 'z']));
  row('M51', async () => {
    expect(valueIndexObservation.threw).toBe(true);
    expect(await queryKeys([api.orderByValue(), api.limitToFirst(2)], { a: 3, b: 1, c: 2 })).toEqual(['b', 'c']);
  });
  row('M52', async () => expect(await queryKeys([api.orderByChild('group'), api.equalTo('x')])).toEqual(['a', 'b']));
  row('M53', async () => {
    const { db } = setup(); await api.set(api.ref(db, 'rows'), { a: { x: 1 } });
    const snap = await api.get(api.query(api.ref(db, 'rows'), api.orderByChild('x'), api.equalTo(9)));
    expect([snap.exists(), snap.size]).toEqual([false, 0]);
  });
  row('M54', async () => expect(await queryKeys([api.orderByChild('score'), api.limitToFirst(2)])).toEqual(['a', 'b']));
  row('M55', async () => expect(await queryKeys([api.orderByChild('score'), api.limitToLast(2)])).toEqual(['c', 'd']));
  row('M56', async () => expect(await queryKeys([api.limitToFirst(20)])).toEqual(['a', 'b', 'c', 'd']));
  row('M57', async () => expect(await queryKeys([api.orderByChild('score'), api.startAfter(1), api.endBefore(4)])).toEqual(['b', 'c']));
  row('M58', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows');
    await api.set(parent, { a: 1, b: 2, c: 3 }); const seen: unknown[] = [];
    const unsub = api.onValue(api.query(parent, api.orderByValue(), api.limitToFirst(2)), snap => seen.push(snap.val()));
    await api.set(api.child(parent, 'c'), 4); expect(seen).toHaveLength(1);
    await api.set(api.child(parent, 'c'), 0); expect(seen).toHaveLength(2); unsub();
  });
  row('M59', async () => {
    const { db } = setup(); const seen: number[] = [];
    const unsub = api.onValue(api.query(api.ref(db, 'missing'), api.orderByKey()), snap => seen.push(snap.size));
    expect(seen).toEqual([0]); unsub();
  });
  row('M60', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: 1, b: 2, c: 3 });
    const chained = api.query(api.query(parent, api.orderByValue()), api.limitToLast(1));
    expect(keys(await api.get(chained))).toEqual(['c']);
  });
  row('M61', async () => expect(await queryKeys([api.orderByChild('score')], { z: { score: 1 }, a: { score: 2 } })).toEqual(['z', 'a']));
  row('M62', async () => expect(await queryKeys([api.orderByChild('group'), api.startAt('x', 'b')])).toEqual(['b', 'c', 'd']));
  row('M63', async () => expect(await queryKeys([api.orderByChild('score')], { a: { other: true }, b: { score: 1 } })).toEqual(['a', 'b']));
  row('M64', async () => {
    const { db } = setup(); const target = api.ref(db, 'primitive'); await api.set(target, 1);
    expect((await api.get(api.query(target, api.orderByKey()))).size).toBe(0);
  });
  row('M65', async () => {
    const { db } = setup(); const target = api.ref(db, 'array'); await api.set(target, ['a', 'b']);
    expect((await api.get(api.child(target, '1'))).val()).toBe('b'); expect(keys(await api.get(target))).toEqual(['0', '1']);
  });
  row('M66', async () => {
    const { db } = setup(); const target = api.ref(db, 'dense'); await api.set(target, { 0: 'a', 1: 'b' });
    expect((await api.get(target)).val()).toEqual(['a', 'b']);
  });
  row('M67', async () => {
    const { db } = setup(); const target = api.ref(db, 'empty'); await api.set(target, { a: null, b: {} });
    expect((await api.get(target)).exists()).toBe(false);
  });
  row('M68', async () => {
    const { db } = setup(); const target = api.ref(db, 'invalid');
    expect(() => api.set(target, undefined)).toThrow(); expect(() => api.set(target, Number.NaN)).toThrow(); expect(() => api.set(target, { 'bad.key': 1 })).toThrow();
  });
  row('M69', () => {
    const { db } = setup(); const target = api.ref(db, 'rows');
    expect(() => api.query(target, api.orderByKey(), api.orderByValue())).toThrow();
    expect(() => api.query(target, api.limitToFirst(1), api.limitToLast(1))).toThrow();
  });
  row('M70', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.write': false } });
    const pushed = api.push(api.ref(db, 'items'), 1); expect(pushed.key).toMatch(/^-/);
    let rejected = false; try { await pushed; } catch { rejected = true; } expect(rejected).toBe(true);
  });
  row('M71', assertSnapshotShape);
  row('M72', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: { x: 1, y: 2 }, b: { y: 2, x: 1 } });
    expect(keys(await api.get(api.query(parent, api.orderByValue())))).toEqual(['a', 'b']);
  });
  row('M73', async () => {
    const { db } = setup(); const root = api.ref(db); await api.set(root, 'hello'); await api.set(api.child(root, 'child'), true);
    expect((await api.get(root)).val()).toEqual({ child: true });
  });
  row('M74', () => assertValueListener('onlyOnce'));
  row('M75', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: 1, b: 2 }); const prior: Array<string | null> = [];
    const unsub = api.onChildAdded(parent, (_snap, previous) => prior.push(previous)); expect(prior).toEqual([null, 'a']); unsub();
  });
  row('M75a', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.read': false } }); const errors: unknown[] = [];
    api.onValue(api.ref(db, 'x'), () => {}, error => errors.push(error)); await Promise.resolve(); expect((errors[0] as { code: string }).code).toBe('PERMISSION_DENIED');
  });
  row('M75b', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: 1, b: 2 }); const seen: string[] = [];
    const unsub = api.onChildAdded(api.query(parent, api.orderByValue(), api.limitToFirst(1)), snap => seen.push(snap.key!)); expect(seen).toEqual(['a']); unsub();
  });
  row('M75c', () => assertChildEvent('moved'));
  row('M75d', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: 1, b: 2 }); const seen: string[] = [];
    api.onChildAdded(parent, snap => seen.push(snap.key!), { onlyOnce: true }); await api.set(api.child(parent, 'c'), 3); expect(seen).toHaveLength(2); expect(seen).not.toContain('c');
  });
  row('M76', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.read': true, '.write': true, item: { '.validate': 'newData.isNumber()' } } });
    await expect(api.set(api.ref(db, 'item'), 'bad')).rejects.toThrow(); expect((await api.get(api.ref(db, 'item'))).val()).toBeNull();
  });
});
