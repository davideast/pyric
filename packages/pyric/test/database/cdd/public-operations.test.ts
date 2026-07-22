import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getDatabase as getFirebaseDatabase } from 'firebase/database';
import {
  TARGET_SYMBOL,
  api,
  assertChildEvent,
  assertMultipath,
  assertNullRemoval,
  assertOverlappingUpdate,
  assertPush,
  assertRoundTrip,
  assertSetReplacement,
  assertTimestamp,
  assertTransaction,
  assertUpdateMerge,
  assertValueListener,
  keys,
  queryKeys,
  setup,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

const contentionObservation = loadObservation('rtdb-modular-concurrent-transforms');
const currentValueObservation = loadObservation('rtdb-modular-runtransaction-current-value-arg');
const valueIndexObservation = loadObservation('rtdb-modular-orderbyvalue-numeric');
const referenceObservation = loadObservation('rtdb-modular-reference-shape-url');
const missingObservation = loadObservation('rtdb-modular-onvalue-initial-no-data');
const abortObservation = loadObservation('rtdb-modular-runtransaction-abort-undefined');
const resultObservation = loadObservation('rtdb-modular-runtransaction-returns-committed-snapshot');

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: public operation rows', () => {
  row('109', () => assertRoundTrip({ answer: 42 }));
  row('110', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.read': false, '.write': true } });
    let error: unknown; try { await api.get(api.ref(db, 'denied')); } catch (caught) { error = caught; }
    expect({ threw: error instanceof Error, code: (error as { code?: string }).code, message: (error as Error).message,
      errorName: (error as Error).name, constructorName: (error as Error).constructor.name, isErrorInstance: error instanceof Error,
    }).toEqual({ threw: true, code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied',
      errorName: 'Error', constructorName: 'Error', isErrorInstance: true });
  });
  row('111', async () => { const { db } = setup(); expect(await api.set(api.ref(db, 'x'), 1)).toBeUndefined(); });
  row('112', () => assertNullRemoval(false));
  row('113', assertSetReplacement);
  row('114', async () => { for (const value of [1, 'x', true, ['a', 'b']]) await assertRoundTrip(value); });
  row('115', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.read': true, '.write': false } });
    let error: unknown; try { await api.set(api.ref(db, 'denied'), 1); } catch (caught) { error = caught; }
    expect({ threw: error instanceof Error, code: (error as { code?: string }).code, message: (error as Error).message,
      errorName: (error as Error).name, constructorName: (error as Error).constructor.name, isErrorInstance: error instanceof Error,
    }).toEqual({ threw: true, code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied',
      errorName: 'Error', constructorName: 'Error', isErrorInstance: true });
  });
  row('116', assertUpdateMerge);
  row('117', assertMultipath);
  row('118', async () => {
    const { db } = setup(); const root = api.ref(db); api.databaseSandbox.setRules(db, { rules: { '.read': true, allowed: { '.write': true }, blocked: { '.write': false } } });
    await expect(api.update(root, { allowed: 1, blocked: 2 })).rejects.toThrow();
    expect([(await api.get(api.ref(db, 'allowed'))).val(), (await api.get(api.ref(db, 'blocked'))).val()]).toEqual([null, null]);
  });
  row('119', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, { a: 1, b: 2 }); await api.update(target, { a: null }); expect((await api.get(target)).val()).toEqual({ b: 2 }); });
  row('120', assertOverlappingUpdate);
  row('121', () => assertNullRemoval(true));
  row('122', async () => { const { db } = setup(); await expect(api.remove(api.ref(db, 'missing'))).resolves.toBeUndefined(); });
  row('123', async () => { await assertNullRemoval(true); await assertNullRemoval(false); });
  row('124', () => assertPush(false));
  row('125', () => { const first = api.pushKey(); const second = api.pushKey(); expect(first < second).toBe(true); });
  row('126', () => assertPush(true));
  row('127', async () => { const { db } = setup(); const pushed = api.push(api.ref(db, 'items'), 1); await pushed; await api.set(pushed, 2); expect((await api.get(pushed)).val()).toBe(2); await api.remove(pushed); expect((await api.get(pushed)).val()).toBeNull(); });
  row('128', () => assertValueListener('initial'));
  row('129', async () => {
    const { db } = setup(); const fires: Array<{ val: unknown; exists: boolean }> = [];
    const unsubscribe = api.onValue(api.ref(db, 'never-written'), snap => fires.push({ val: snap.val(), exists: snap.exists() }));
    expect(fires).toEqual([{ val: missingObservation.firstFireVal, exists: missingObservation.firstFireExists }]);
    expect(fires).toHaveLength(missingObservation.initialFires); unsubscribe();
  });
  row('130', () => assertValueListener('change'));
  row('131', () => assertValueListener('unsubscribe'));
  row('132', () => { const { db } = setup(); const unsubscribe = api.onValue(api.ref(db, 'x'), () => {}); expect(typeof unsubscribe).toBe('function'); unsubscribe(); });
  row('133', () => assertChildEvent('added'));
  row('134', () => assertChildEvent('added'));
  row('135', async () => {
    const { db } = setup(); const parent = api.ref(db, 'changed'); await api.set(parent, { k1: { v: 1 } });
    const events: Array<[string | null, unknown]> = []; const unsubscribe = api.onChildChanged(parent, snap => events.push([snap.key, snap.val()]));
    await api.set(api.child(parent, 'k2'), { v: 1 }); await api.update(api.child(parent, 'k1'), { v: 2 }); await api.remove(api.child(parent, 'k2'));
    expect(events).toEqual([['k1', { v: 2 }]]); unsubscribe();
  });
  row('136', () => assertChildEvent('removed'));
  row('137', async () => {
    const { db } = setup(); const parent = api.ref(db, 'moved');
    await api.set(parent, { k1: { rank: 1, label: 'a' }, k2: { rank: 2, label: 'b' }, k3: { rank: 3, label: 'c' } });
    const source = api.query(parent, api.orderByChild('rank')); const moved: Array<[string | null, string | null]> = []; const changed: string[] = [];
    const stopMoved = api.onChildMoved(source, (snap, previous) => moved.push([snap.key, previous]));
    const stopChanged = api.onChildChanged(source, snap => changed.push(snap.key!));
    await api.update(api.child(parent, 'k1'), { rank: 4 });
    await api.update(api.child(parent, 'k1'), { rank: 2.5 });
    await api.update(api.child(parent, 'k1'), { rank: 0 });
    await api.update(api.child(parent, 'k2'), { label: 'changed' });
    expect(moved).toEqual([['k1', 'k3'], ['k1', 'k2'], ['k1', null]]);
    expect(changed).toEqual(['k1', 'k1', 'k1', 'k2']); stopMoved(); stopChanged();
  });
  row('138', async () => {
    const { db } = setup(); const target = api.ref(db, 'x'); const fires = { value: 0, added: 0, changed: 0, removed: 0 };
    api.onValue(target, () => fires.value++); api.onChildAdded(target, () => fires.added++);
    api.onChildChanged(target, () => fires.changed++); api.onChildRemoved(target, () => fires.removed++);
    api.off(target); await api.set(api.child(target, 'a'), 1); await api.set(api.child(target, 'a'), 2); await api.remove(api.child(target, 'a'));
    expect(fires).toEqual({ value: 1, added: 0, changed: 0, removed: 0 });
  });
  row('139', async () => { const { db } = setup(); const target = api.ref(db, 'x'); const fires = [0, 0]; api.onValue(target, () => fires[0]++); api.onChildAdded(target, () => fires[1]++); api.off(target, 'value'); await api.set(api.child(target, 'a'), 1); expect(fires).toEqual([1, 1]); api.off(target); });
  row('140', async () => { const { db } = setup(); const target = api.ref(db, 'x'); const fires = [0, 0]; const a = () => fires[0]++; const b = () => fires[1]++; api.onValue(target, a); api.onValue(target, b); api.off(target, 'value', a); await api.set(target, 1); expect(fires).toEqual([1, 2]); api.off(target); });
  row('141', async () => {
    const { db } = setup(); const first = api.ref(db, 'unsub-return'); const second = api.ref(db, 'off-form'); const fires = [0, 0];
    const firstCallback = () => fires[0]++; const secondCallback = () => fires[1]++;
    const unsubscribe = api.onValue(first, firstCallback); api.onValue(second, secondCallback);
    expect(typeof unsubscribe).toBe('function'); unsubscribe(); api.off(second, 'value', secondCallback);
    await api.set(first, 1); await api.set(second, 1); expect(fires).toEqual([1, 1]);
  });
  row('183', async () => { const { db } = setup(); const target = api.ref(db, 'x'); let fires = 0; const callback = () => fires++; api.onValue(target, callback); api.onValue(target, callback); api.off(target, 'value', callback); await api.set(target, 1); expect(fires).toBe(3); api.off(target); });
  row('142', async () => expect(await queryKeys([api.orderByChild('score'), api.limitToFirst(2)])).toEqual(['a', 'b']));
  row('143', async () => expect(await queryKeys([api.orderByKey()], { '10': 1, '2': 1, '1': 1 })).toEqual(['1', '2', '10']));
  row('144', async () => { expect(valueIndexObservation.threw).toBe(true); expect(await queryKeys([api.orderByValue()], { a: 2, b: 1 })).toEqual(['b', 'a']); });
  row('145', async () => expect(await queryKeys([api.orderByChild('group'), api.equalTo('x')])).toEqual(['a', 'b']));
  row('146', async () => expect(await queryKeys([api.orderByChild('score'), api.startAt(2)])).toEqual(['b', 'c', 'd']));
  row('147', async () => expect(await queryKeys([api.orderByChild('score'), api.endAt(2)])).toEqual(['a', 'b']));
  row('148', async () => expect(await queryKeys([api.orderByChild('score'), api.startAfter(2)])).toEqual(['c', 'd']));
  row('149', async () => expect(await queryKeys([api.orderByChild('score'), api.endBefore(3)])).toEqual(['a', 'b']));
  row('150', async () => expect(await queryKeys([api.orderByChild('score'), api.limitToFirst(2)])).toHaveLength(2));
  row('151', async () => expect(await queryKeys([api.orderByChild('score'), api.limitToLast(2)])).toEqual(['c', 'd']));
  row('152', async () => { const { db } = setup(); const parent = api.ref(db, 'rows'); await api.set(parent, { a: 1, b: 2, c: 3 }); const seen: unknown[] = []; const unsub = api.onValue(api.query(parent, api.orderByValue(), api.limitToFirst(1)), snap => seen.push(snap.val())); expect(seen).toEqual([{ a: 1 }]); unsub(); });
  row('153', () => assertTimestamp(false));
  row('154', () => assertTimestamp(true));
  row('155', async () => { const { db } = setup(); const target = api.ref(db, 'count'); await api.set(target, api.increment(5)); expect((await api.get(target)).val()).toBe(5); });
  row('156', async () => { const { db } = setup(); const target = api.ref(db, 'count'); await api.set(target, 5); await api.set(target, api.increment(-2)); expect((await api.get(target)).val()).toBe(3); });
  row('157', async () => { const sandbox = setup().sandbox; const first = api.getDatabase(sandbox); const second = api.getDatabase(sandbox); const target = api.ref(first, 'count'); await api.set(target, 0); const firstWrite = api.set(target, api.increment(2)); expect(first[TARGET_SYMBOL].backend.adminGet('/count')).toBe(2); await Promise.all([firstWrite, api.set(api.ref(second, 'count'), api.increment(3))]); expect([(await api.get(target)).val(), contentionObservation.incrementTerminal]).toEqual([5, 5]); });
  row('158', () => assertTransaction('commit'));
  row('159', async () => {
    const { db } = setup(); const target = api.ref(db, 'abort'); await api.set(target, 100);
    const result = await api.runTransaction(target, () => undefined);
    expect(abortObservation.snapVal).toBeNull();
    expect({ committed: result.committed, snapshotCarriesExistingValue: result.snapshot.val(), afterValOnServer: (await api.get(target)).val(),
      abortedAndPreservedValue: !result.committed && (await api.get(target)).val() === 100,
    }).toEqual({ committed: abortObservation.committed, snapshotCarriesExistingValue: 100,
      afterValOnServer: abortObservation.afterValOnServer, abortedAndPreservedValue: abortObservation.abortedAndPreservedValue });
  });
  row('160', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 1); const seen: unknown[] = []; const result = await api.runTransaction(target, value => { seen.push(value); return value; }, { applyLocally: false }); expect(currentValueObservation.seededArgs).toHaveLength(2); expect(seen).toEqual([1]); expect([result.committed, result.snapshot.val(), (await api.get(target)).val()]).toEqual([true, 1, 1]); });
  row('161', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 0); const calls = [0, 0]; await Promise.all([api.runTransaction(target, v => { calls[0]++; return (v as number) + 1; }), api.runTransaction(target, v => { calls[1]++; return (v as number) + 1; })]); expect(contentionObservation.invocationCountsSorted).toEqual([2, 3]); expect(calls).toEqual([1, 1]); expect((await api.get(target)).val()).toBe(2); });
  row('162', async () => {
    const { db } = setup(); const target = api.ref(db, 'v'); const result = await api.runTransaction(target, () => ({ count: 42 }));
    expect({ resultKeys: Object.keys(result).sort(), committed: result.committed, committedType: typeof result.committed,
      hasSnapshotProp: 'snapshot' in result, snapshotValIsFn: typeof result.snapshot.val === 'function', snapVal: result.snapshot.val(),
      snapExists: result.snapshot.exists(), snapKey: result.snapshot.key, committedReflectsNewValue: result.snapshot.val().count === 42,
    }).toEqual({ resultKeys: [...resultObservation.resultKeys].sort(), committed: resultObservation.committed,
      committedType: resultObservation.committedType, hasSnapshotProp: resultObservation.hasSnapshotProp,
      snapshotValIsFn: resultObservation.snapshotValIsFn, snapVal: resultObservation.snapVal,
      snapExists: resultObservation.snapExists, snapKey: resultObservation.snapKey,
      committedReflectsNewValue: resultObservation.committedReflectsNewValue });
  });
  row('163', async () => {
    const { db } = setup(); const target = api.ref(db, 'x'); const disconnect = api.ref(db, 'presence'); const values: unknown[] = [];
    await api.set(disconnect, 'online'); await api.onDisconnect(disconnect).set('offline'); api.onValue(target, snap => values.push(snap.val()));
    api.goOffline(db); expect((await api.get(disconnect)).val()).toBe('offline'); await api.set(target, 1);
    expect([(await api.get(target)).val(), values]).toEqual([1, [null, 1]]);
  });
  row('164', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.onDisconnect(target).set(1); api.goOffline(db); api.goOnline(db); await api.set(target, 2); api.goOffline(db); expect((await api.get(target)).val()).toBe(2); });
  row('165', () => { const { db } = setup(); expect(api.connectDatabaseEmulator(db, 'localhost', 9000)).toBeUndefined(); });
  row('166', async () => {
    const app = initializeApp({ projectId: 'cdd-production-boundary', databaseURL: 'https://cdd-production-boundary.firebaseio.com' }, `cdd-production-${Date.now()}`);
    try { expect(api.TARGET_SYMBOL in getFirebaseDatabase(app)).toBe(false); expect(() => api.getDatabase(app as never)).toThrow(/package resolution/i); }
    finally { await deleteApp(app); }
  });
  row('171', () => expect(api.forceLongPolling()).toBeUndefined());
  row('172', () => expect(api.forceWebSockets()).toBeUndefined());
  row('173', () => expect(api.enableLogging(() => {}, true)).toBeUndefined());
  row('174', () => { const { db } = setup(); expect(referenceObservation.mismatchedHost.timing).toBe('synchronous-throw'); const parsed = api.refFromURL(db, 'ftp://other.example/a/b?ignored=1'); expect([parsed.key, parsed.toString()]).toEqual(['b', 'sandbox://rtdb/a/b']); expect(() => api.refFromURL(db, 'https://other.example/a#fragment')).toThrow(); });
});
