import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  TARGET_SYMBOL,
  api,
  assertChildEvent,
  assertDisconnect,
  assertPriority,
  assertReferenceShape,
  assertSnapshotShape,
  assertTransaction,
  keys,
  setup,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

const abruptObservation = loadObservation('rtdb-modular-ondisconnect-abrupt-exit');
const referenceObservation = loadObservation('rtdb-modular-reference-shape-url');
const runtimeIdentityObservation = loadObservation('rtdb-modular-runtime-class-identity');
const queryValidationObservation = loadObservation('rtdb-modular-query-construction-validation');

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: lifecycle and runtime identity rows', () => {
  row('M77', () => assertDisconnect('shape'));
  row('M78', () => assertDisconnect('deferred'));
  row('M79', () => assertDisconnect('once'));
  row('M80', () => assertDisconnect('cancel'));
  row('M81', async () => {
    const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 1); await api.onDisconnect(target).set(2);
    api.databaseSandbox.setRules(db, { rules: { '.write': false, '.read': true } }); api.goOffline(db); await Promise.resolve();
    expect((await api.get(target)).val()).toBe(1);
  });
  row('M82', async () => {
    const sandbox = initializeSandbox(); const first = api.getDatabase(sandbox); const second = api.getDatabase(sandbox);
    await api.onDisconnect(api.ref(first, 'first')).set(true); api.goOffline(second);
    expect((await api.get(api.ref(first, 'first'))).val()).toBeNull(); expect(api.databaseSandbox.snapshotState(first)).toEqual({});
  });
  row('M83', () => assertDisconnect('priority'));
  row('M84', async () => {
    const { db } = setup(); const target = api.ref(db, 'x'); await api.onDisconnect(target).set(true);
    expect(abruptObservation.exitWasForced).toBe(true); expect(abruptObservation.terminal).toEqual({ state: 'offline' });
    expect((await api.get(target)).val()).toBeNull(); api.goOffline(db); expect((await api.get(target)).val()).toBe(true);
  });
  row('M85', () => {
    const { db } = setup();
    expect(runtimeIdentityObservation.database).toMatchObject({ constructorName: 'Database', instanceOf: true, prototypeIsExportPrototype: true });
    expect([db.constructor.name, db instanceof api.Database, Object.getPrototypeOf(db)]).toEqual(['Database', true, api.Database.prototype]);
  });
  row('M86', async () => {
    await assertSnapshotShape(); const { db } = setup(); const snapshot = await api.get(api.ref(db));
    expect(runtimeIdentityObservation.snapshot).toMatchObject({ constructorName: 'DataSnapshot', instanceOf: true, prototypeIsExportPrototype: true });
    expect([snapshot.constructor.name, snapshot instanceof api.DataSnapshot, Object.getPrototypeOf(snapshot)]).toEqual(['DataSnapshot', true, api.DataSnapshot.prototype]);
  });
  row('M87', () => {
    const constraints = [api.orderByKey(), api.startAt('a'), api.endAt('z'), api.limitToFirst(1)];
    expect(runtimeIdentityObservation.queryConstraint).toMatchObject({ instanceOf: true, prototypeIsExportPrototype: false });
    expect(constraints.every(value => value instanceof api.QueryConstraint)).toBe(true);
    expect(constraints.map(value => typeof (value as { _apply?: unknown })._apply)).toEqual(['function', 'function', 'function', 'function']);
  });
  row('M88', async () => {
    await assertTransaction('commit'); const { db } = setup(); const result = await api.runTransaction(api.ref(db, 'identity'), () => 1);
    expect(runtimeIdentityObservation.transactionResult).toMatchObject({ constructorName: 'TransactionResult', instanceOf: true, prototypeIsExportPrototype: true, toJSONType: 'function' });
    expect([result.constructor.name, result instanceof api.TransactionResult, Object.getPrototypeOf(result), result.toJSON()]).toEqual(['TransactionResult', true, api.TransactionResult.prototype, { committed: true, snapshot: 1 }]);
  });
  row('M89', assertPriority);
  row('M90', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows');
    await api.setWithPriority(api.child(parent, 'b'), true, 1); await api.setWithPriority(api.child(parent, 'a'), true, 1); await api.setWithPriority(api.child(parent, 'c'), true, 2);
    expect(keys(await api.get(api.query(parent, api.orderByPriority())))).toEqual(['a', 'b', 'c']);
  });
  row('M91', () => assertChildEvent('moved'));
  row('M92', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); const q = api.query(parent, api.orderByKey(), api.limitToFirst(1)); const seen = [0, 0];
    api.onValue(parent, () => seen[0]++); api.onValue(q, () => seen[1]++); api.off(q); await api.set(api.child(parent, 'a'), 1);
    expect(seen).toEqual([2, 1]); api.off(parent);
  });
  row('M93', () => {
    const { db } = setup(); const a = api.ref(db, 'a'); const q = api.query(a, api.orderByKey());
    expect(referenceObservation.queryIdentity.referenceToJSON.protocol).toBe('https:');
    expect([a.isEqual(api.ref(db, 'a')), q.isEqual(api.query(a, api.orderByKey())), q.toJSON()]).toEqual([true, true, 'sandbox://rtdb/a']);
  });
  row('M94', () => {
    const { db } = setup(); const target = api.ref(db, 'rows');
    expect(queryValidationObservation).toMatchObject({ repeatCount: 2, contractDigest: 'd8e121139846b37dec3df876f9f26256af5b32459377dc4ecfac7a01c2a1f362' });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '1' as never]) expect(() => api.limitToFirst(invalid)).toThrow();
    expect(() => api.limitToFirst(Number.POSITIVE_INFINITY)).not.toThrow();
    for (const invalid of ['$key', '$priority', '$value', '', 'bad#path', 'bad.path']) expect(() => api.orderByChild(invalid)).toThrow();
    expect(() => api.query(target, api.orderByKey(), api.startAt({} as never))).toThrow();
    expect(() => api.query(target, api.orderByPriority(), api.startAt(api.serverTimestamp() as never))).not.toThrow();
  });

  row('94', () => {
    const sandbox = initializeSandbox(); expect(api.getDatabase(sandbox.withAuth({ uid: 'x' }))[TARGET_SYMBOL].kind).toBe('sandbox');
  });
  row('95', () => {
    const sandbox = initializeSandbox(); expect(api.getDatabase(sandbox)[TARGET_SYMBOL].kind).toBe('sandbox-live');
  });
  row('96', () => expect(() => api.getDatabase({} as never)).toThrow(/package resolution/i));
  row('97', () => expect(() => api.getDatabase()).toThrow(/default sandbox app registry|no firebase app|package resolution/i));
  row('98', async () => {
    const sandbox = initializeSandbox(); const a = api.getDatabase(sandbox); const b = api.getDatabase(sandbox); await api.set(api.ref(a, 'x'), 1);
    expect((await api.get(api.ref(b, 'x'))).val()).toBe(1);
  });
  row('99', async () => {
    const a = api.getDatabase(initializeSandbox()); const b = api.getDatabase(initializeSandbox()); await api.set(api.ref(a, 'x'), 1); await api.set(api.ref(b, 'x'), 2);
    expect([(await api.get(api.ref(a, 'x'))).val(), (await api.get(api.ref(b, 'x'))).val()]).toEqual([1, 2]);
  });
  row('100', () => {
    assertReferenceShape(); const { db } = setup();
    for (const path of ['bad.path', 'bad#path', 'bad$path', 'bad[path', 'bad]path']) expect(() => api.ref(db, path)).toThrow(/invalid path/);
  });
  row('101', () => { const { db } = setup(); const root = api.ref(db); expect([root.key, root.parent]).toEqual([null, null]); });
  row('102', () => { const { db } = setup(); const nested = api.child(api.ref(db, 'a'), 'b/c'); expect([nested.key, nested.parent?.key]).toEqual(['c', 'b']); for (const path of ['', 'bad#path', 'bad.path']) expect(() => api.child(api.ref(db), path)).toThrow(/invalid path/); });
  row('103', () => { const { db } = setup(); expect([api.ref(db).parent, api.ref(db, 'a/b').parent?.key]).toEqual([null, 'a']); });
  row('104', () => { const { db } = setup(); expect([api.ref(db).key, api.ref(db, 'a/b').key]).toEqual([null, 'b']); });
  row('105', () => { let error: unknown; try { void api.get({} as never); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(TypeError); });
  row('106', assertSnapshotShape);
  row('107', async () => { const { db } = setup(); expect((await api.get(api.ref(db, 'missing'))).val()).toBeNull(); });
  row('108', async () => { const { db } = setup(); const target = api.ref(db, 'x'); expect((await api.get(target)).exists()).toBe(false); await api.set(target, 0); expect((await api.get(target)).exists()).toBe(true); });
});
