/**
 * Regression tests for #1925 (own-property snapshot and query child lookups),
 * #1926 (same-path onDisconnect sparse composition), and #1934 (unbounded
 * ordered queries over primitive leaves).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  equalTo,
  get,
  getDatabase,
  goOffline,
  goOnline,
  limitToFirst,
  limitToLast,
  onDisconnect,
  onValue,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  sandbox as rtdbSandbox,
  set,
  startAt,
} from '../../src/database/index.js';
import { valueAtChildPath } from '../../src/database/internal.js';

function openDb() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  rtdbSandbox.setDefaultPolicy(db, 'allow');
  return db;
}

describe('snapshot own-property reads and query child extraction (#1925)', () => {
  const inheritedKeys = [
    'valueOf',
    'toString',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ];

  it('reports inherited Object.prototype keys as absent on plain, array, and query snapshots', async () => {
    const db = openDb();
    await set(ref(db, 'obj'), { a: 1, nested: { b: 2 } });
    await set(ref(db, 'arr'), ['x', 'y']);

    const objSnap = await get(ref(db, 'obj'));
    const querySnap = await get(query(ref(db, 'obj'), orderByKey()));
    const arrSnap = await get(ref(db, 'arr'));

    for (const key of inheritedKeys) {
      expect(objSnap.hasChild(key)).toBe(false);
      expect(objSnap.child(key).exists()).toBe(false);
      expect(objSnap.child(key).val()).toBeNull();
      expect(objSnap.hasChild(`nested/${key}`)).toBe(false);
      expect(objSnap.child(`nested/${key}`).val()).toBeNull();

      expect(querySnap.hasChild(key)).toBe(false);
      expect(querySnap.child(key).exists()).toBe(false);
      expect(querySnap.child(key).val()).toBeNull();

      expect(arrSnap.hasChild(key)).toBe(false);
      expect(arrSnap.child(key).exists()).toBe(false);
      expect(arrSnap.child(key).val()).toBeNull();
    }

    for (const arrayProp of ['length', 'map', 'push']) {
      expect(arrSnap.hasChild(arrayProp)).toBe(false);
      expect(arrSnap.child(arrayProp).exists()).toBe(false);
      expect(arrSnap.child(arrayProp).val()).toBeNull();
    }
    expect(arrSnap.hasChild('0')).toBe(true);
    expect(arrSnap.child('0').val()).toBe('x');

    // Internal valueAtChildPath must ignore non-enumerable own properties like Array.length.
    expect(valueAtChildPath(['x', 'y'], ['length'])).toBeNull();
    expect(valueAtChildPath(['x', 'y'], ['toString'])).toBeNull();
    expect(valueAtChildPath(['x', 'y'], ['0'])).toBe('x');
  });

  it('still reads genuine own properties named valueOf or toString and treats missing ones as null in orderByChild', async () => {
    const db = openDb();
    await set(ref(db, 'own'), { valueOf: 'stored-valueOf', toString: 'stored-toString' });
    const ownSnap = await get(ref(db, 'own'));
    expect(ownSnap.hasChild('valueOf')).toBe(true);
    expect(ownSnap.child('valueOf').val()).toBe('stored-valueOf');
    expect(ownSnap.hasChild('toString')).toBe(true);
    expect(ownSnap.child('toString').val()).toBe('stored-toString');

    await set(ref(db, 'rows'), { a: 1, nested: { b: 2 } });
    const matchedNull = await get(query(ref(db, 'rows'), orderByChild('valueOf'), equalTo(null)));
    expect(matchedNull.val()).toEqual({ a: 1, nested: { b: 2 } });

    const orderedByToString = await get(query(ref(db, 'rows'), orderByChild('toString'), equalTo(null)));
    expect(orderedByToString.val()).toEqual({ a: 1, nested: { b: 2 } });
  });
});

describe('onDisconnect same-path sparse composition (#1926)', () => {
  it('preserves both updates at the same ref and merges set followed by update', async () => {
    const db = openDb();

    const first = ref(db, 'presence/u1');
    await set(first, { existing: true });
    await onDisconnect(first).update({ a: 1 });
    await onDisconnect(first).update({ b: 2 });

    const second = ref(db, 'presence/u2');
    await set(second, { stale: true });
    await onDisconnect(second).set({ x: 1, y: 2 });
    await onDisconnect(second).update({ y: 20, z: 30 });

    const third = ref(db, 'presence/u3');
    await set(third, { old: true });
    await onDisconnect(third).set({ keep: 1, drop: 2 });
    await onDisconnect(third).update({ drop: null });

    const fourth = ref(db, 'presence/u4');
    await set(fourth, { old: true });
    await onDisconnect(fourth).remove();
    await onDisconnect(fourth).update({ fresh: 1 });

    const fifth = ref(db, 'presence/u5');
    await set(fifth, { base: true });
    await onDisconnect(fifth).update({ a: 1, b: 2 });
    await onDisconnect(ref(db, 'presence/u5/b')).cancel();

    goOffline(db);
    await Promise.resolve();
    goOnline(db);

    expect((await get(first)).val()).toEqual({ existing: true, a: 1, b: 2 });
    expect((await get(second)).val()).toEqual({ x: 1, y: 20, z: 30 });
    expect((await get(third)).val()).toEqual({ keep: 1 });
    expect((await get(fourth)).val()).toEqual({ fresh: 1 });
    expect((await get(fifth)).val()).toEqual({ base: true, a: 1 });
  });
});

describe('unbounded ordered queries over primitive leaves (#1934)', () => {
  it('returns the primitive for unbounded orderBy* queries and null for limited or ranged queries', async () => {
    const db = openDb();
    const statusRef = ref(db, 'status');
    await set(statusRef, 'hello');

    const unbounded = [
      query(statusRef, orderByKey()),
      query(statusRef, orderByChild('x')),
      query(statusRef, orderByValue()),
      query(statusRef, orderByPriority()),
    ];
    for (const q of unbounded) {
      const snap = await get(q);
      expect(snap.exists()).toBe(true);
      expect(snap.val()).toBe('hello');
      expect(snap.size).toBe(0);

      const seen: Array<{ exists: boolean; val: unknown }> = [];
      const stop = onValue(q, (s) => {
        seen.push({ exists: s.exists(), val: s.val() });
      });
      stop();
      expect(seen).toEqual([{ exists: true, val: 'hello' }]);
    }

    const bounded = [
      query(statusRef, orderByKey(), limitToFirst(1)),
      query(statusRef, orderByKey(), limitToLast(1)),
      query(statusRef, orderByKey(), startAt('a')),
      query(statusRef, orderByValue(), equalTo('hello')),
    ];
    for (const q of bounded) {
      const snap = await get(q);
      expect(snap.exists()).toBe(false);
      expect(snap.val()).toBeNull();
    }
  });
});
