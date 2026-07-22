import { describe, expect, it } from 'bun:test';
import {
  api,
  assertValueListener,
  keys,
  queryKeys,
  setup,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';
import {
  assertM50NameOrdering,
  assertM66ArrayCoercionThresholds,
  assertM69ConstraintConflicts,
  assertM72ObjectOrderEquality,
} from './query-value-contracts.js';
import {
  assertM68WriteValidationMatrix,
  assertM76ValidateAtomicity,
} from './validation-atomicity-contracts.js';
import {
  assertM70PushThenable,
  assertM71SnapshotContract,
} from './snapshot-thenable-contracts.js';
import {
  assertM75PreviousNames,
  assertM75aCancellation,
  assertM75bQueryWindows,
  assertM75cMovementCofire,
  assertM75dOnlyOnceOverloads,
} from './listener-observation-contracts.js';

const valueIndexObservation = loadObservation('rtdb-modular-orderbyvalue-numeric');
const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: query, normalization, and listener rows', () => {
  row('M49', async () => expect(await queryKeys([api.orderByChild('score'), api.startAt(2), api.endAt(3)])).toEqual(['b', 'c']));
  row('M50', assertM50NameOrdering);
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
    const { db } = setup(); const seen: Array<[boolean, number]> = [];
    const unsub = api.onValue(api.query(api.ref(db, 'missing'), api.orderByKey()), snap => seen.push([snap.exists(), snap.size]));
    expect(seen).toEqual([[false, 0]]); unsub();
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
    const { db } = setup();
    for (const [path, value] of [['primitive', 1], ['absent', undefined]] as const) {
      const target = api.ref(db, path); if (value !== undefined) await api.set(target, value);
      const snap = await api.get(api.query(target, api.orderByKey()));
      expect([snap.exists(), snap.size, keys(snap)]).toEqual([false, 0, []]);
    }
  });
  row('M65', async () => {
    const { db } = setup(); const target = api.ref(db, 'array'); await api.set(target, ['a', 'b']);
    expect((await api.get(api.child(target, '1'))).val()).toBe('b'); expect(keys(await api.get(target))).toEqual(['0', '1']);
  });
  row('M66', assertM66ArrayCoercionThresholds);
  row('M67', async () => {
    const { db } = setup(); const target = api.ref(db, 'empty'); await api.set(target, { a: null, b: {} });
    expect((await api.get(target)).exists()).toBe(false);
  });
  row('M68', assertM68WriteValidationMatrix);
  row('M69', assertM69ConstraintConflicts);
  row('M70', assertM70PushThenable);
  row('M71', assertM71SnapshotContract);
  row('M72', assertM72ObjectOrderEquality);
  row('M73', async () => {
    const { db } = setup(); const root = api.ref(db); await api.set(root, 'hello'); await api.set(api.child(root, 'child'), true);
    expect((await api.get(root)).val()).toEqual({ child: true });
  });
  row('M74', () => assertValueListener('onlyOnce'));
  row('M75', assertM75PreviousNames);
  row('M75a', assertM75aCancellation);
  row('M75b', assertM75bQueryWindows);
  row('M75c', assertM75cMovementCofire);
  row('M75d', assertM75dOnlyOnceOverloads);
  row('M76', assertM76ValidateAtomicity);
});
