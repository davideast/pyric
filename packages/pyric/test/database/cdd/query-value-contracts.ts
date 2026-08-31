import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as api from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = api.getDatabase(sandbox.withAuth({ uid: 'alice' }));
  api.sandbox.setDefaultPolicy(db, 'allow');
  return db;
}

function snapshotKeys(snapshot: api.DataSnapshot): string[] {
  const result: string[] = [];
  snapshot.forEach(child => { if (child.key) result.push(child.key); return false; });
  return result;
}

export async function assertM50NameOrdering(): Promise<void> {
  const db = setup();
  const target = api.ref(db, 'rows');
  await api.set(target, {
    z: { score: 1 },
    '2147483648': { score: 1 },
    '10': { score: 1 },
    '2': { score: 1 },
    '1': { score: 1 },
  });
  expect(snapshotKeys(await api.get(api.query(target, api.orderByKey())))).toEqual([
    '1', '2', '10', '2147483648', 'z',
  ]);
  expect(snapshotKeys(await api.get(api.query(target, api.orderByKey(), api.startAt('2'), api.endAt('2147483648'))))).toEqual([
    '2', '10', '2147483648',
  ]);
  expect(snapshotKeys(await api.get(api.query(target, api.orderByChild('score'), api.startAt(1, '2'))))).toEqual([
    '2', '10', '2147483648', 'z',
  ]);
}

export async function assertM66ArrayCoercionThresholds(): Promise<void> {
  const db = setup();
  for (const [path, value, expected] of [
    ['dense', { 0: 'a', 1: 'b' }, ['a', 'b']],
    ['sparse-below-threshold', { 0: 'a', 2: 'c' }, ['a', null, 'c']],
    ['at-threshold', { 0: 'a', 4: 'e' }, { 0: 'a', 4: 'e' }],
    ['non-integer', { 0: 'a', x: 'x' }, { 0: 'a', x: 'x' }],
  ] as const) {
    await api.set(api.ref(db, path), value);
    expect((await api.get(api.ref(db, path))).val()).toEqual(expected);
  }
}

export function assertM69ConstraintConflicts(): void {
  const db = setup();
  const target = api.ref(db, 'rows');
  const conflicts: api.QueryConstraint[][] = [
    [api.orderByKey(), api.orderByValue()],
    [api.orderByChild('a'), api.orderByChild('b')],
    [api.limitToFirst(1), api.limitToFirst(2)],
    [api.limitToLast(1), api.limitToLast(2)],
    [api.limitToFirst(1), api.limitToLast(1)],
    [api.startAt(1), api.startAt(2)],
    [api.startAt(1), api.startAfter(2)],
    [api.startAfter(1), api.equalTo(2)],
    [api.endAt(2), api.endBefore(1)],
    [api.endBefore(2), api.equalTo(1)],
    [api.equalTo(1), api.startAt(1)],
    [api.equalTo(1), api.endAt(1)],
  ];
  for (const constraints of conflicts) expect(() => api.query(target, ...constraints)).toThrow(Error);
}

export async function assertM72ObjectOrderEquality(): Promise<void> {
  const db = setup();
  const target = api.ref(db, 'rows');
  await api.set(target, { a: { z: 1, a: 2 }, b: { a: 1 } });
  const ordered = api.query(target, api.orderByValue());
  expect(snapshotKeys(await api.get(ordered))).toEqual(['a', 'b']);
  const fires: unknown[] = [];
  const unsubscribe = api.onValue(ordered, snapshot => fires.push(snapshot.val()));
  await api.set(api.child(target, 'a'), { a: 2, z: 1 });
  expect(fires).toEqual([{ a: { a: 2, z: 1 }, b: { a: 1 } }]);
  unsubscribe();
}
