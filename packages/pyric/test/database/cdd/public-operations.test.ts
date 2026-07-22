import { describe, expect, it } from 'bun:test';
import {
  TARGET_SYMBOL,
  api,
  assertChildEvent,
  assertDenied,
  assertDisconnect,
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

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: public operation rows', () => {
  row('109', () => assertRoundTrip({ answer: 42 }));
  row('110', () => assertDenied('read'));
  row('111', async () => { const { db } = setup(); expect(await api.set(api.ref(db, 'x'), 1)).toBeUndefined(); });
  row('112', () => assertNullRemoval(false));
  row('113', assertSetReplacement);
  row('114', async () => { for (const value of [1, 'x', true, ['a', 'b']]) await assertRoundTrip(value); });
  row('115', () => assertDenied('write'));
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
  row('129', () => assertValueListener('missing'));
  row('130', () => assertValueListener('change'));
  row('131', () => assertValueListener('unsubscribe'));
  row('132', () => { const { db } = setup(); const unsubscribe = api.onValue(api.ref(db, 'x'), () => {}); expect(typeof unsubscribe).toBe('function'); unsubscribe(); });
  row('133', () => assertChildEvent('added'));
  row('134', () => assertChildEvent('added'));
  row('135', async () => { await assertChildEvent('changed'); await assertChildEvent('no-change'); });
  row('136', () => assertChildEvent('removed'));
  row('137', () => assertChildEvent('moved'));
  row('138', async () => { const { db } = setup(); const target = api.ref(db, 'x'); let fires = 0; api.onValue(target, () => fires++); api.off(target); await api.set(target, 1); expect(fires).toBe(1); });
  row('139', async () => { const { db } = setup(); const target = api.ref(db, 'x'); const fires = [0, 0]; api.onValue(target, () => fires[0]++); api.onChildAdded(target, () => fires[1]++); api.off(target, 'value'); await api.set(api.child(target, 'a'), 1); expect(fires).toEqual([1, 1]); api.off(target); });
  row('140', async () => { const { db } = setup(); const target = api.ref(db, 'x'); const fires = [0, 0]; const a = () => fires[0]++; const b = () => fires[1]++; api.onValue(target, a); api.onValue(target, b); api.off(target, 'value', a); await api.set(target, 1); expect(fires).toEqual([1, 2]); api.off(target); });
  row('141', () => assertValueListener('unsubscribe'));
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
  row('159', () => assertTransaction('abort'));
  row('160', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 1); const seen: unknown[] = []; await api.runTransaction(target, value => { seen.push(value); return value; }); expect(currentValueObservation.seededArgs).toHaveLength(2); expect(seen).toEqual([1]); });
  row('161', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 0); const calls = [0, 0]; await Promise.all([api.runTransaction(target, v => { calls[0]++; return (v as number) + 1; }), api.runTransaction(target, v => { calls[1]++; return (v as number) + 1; })]); expect(contentionObservation.invocationCountsSorted).toEqual([2, 3]); expect(calls).toEqual([1, 1]); expect((await api.get(target)).val()).toBe(2); });
  row('162', () => assertTransaction('commit'));
  row('163', async () => { const { db } = setup(); const target = api.ref(db, 'x'); api.goOffline(db); await api.set(target, 1); expect((await api.get(target)).val()).toBe(1); });
  row('164', async () => { const { db } = setup(); const target = api.ref(db, 'x'); await api.onDisconnect(target).set(1); api.goOffline(db); api.goOnline(db); await api.set(target, 2); api.goOffline(db); expect((await api.get(target)).val()).toBe(2); });
  row('165', () => { const { db } = setup(); expect(api.connectDatabaseEmulator(db, 'localhost', 9000)).toBeUndefined(); });
  row('166', () => expect(() => api.getDatabase({} as never)).toThrow(/package resolution/i));
  row('171', () => expect(api.forceLongPolling()).toBeUndefined());
  row('172', () => expect(api.forceWebSockets()).toBeUndefined());
  row('173', () => expect(api.enableLogging(() => {}, true)).toBeUndefined());
  row('174', () => { const { db } = setup(); expect(referenceObservation.mismatchedHost.timing).toBe('synchronous-throw'); const parsed = api.refFromURL(db, 'ftp://other.example/a/b?ignored=1'); expect([parsed.key, parsed.toString()]).toEqual(['b', 'sandbox://rtdb/a/b']); expect(() => api.refFromURL(db, 'https://other.example/a#fragment')).toThrow(); });
});
