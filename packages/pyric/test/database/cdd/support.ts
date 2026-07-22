import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DataSnapshot,
  Database,
  QueryConstraint,
  TransactionResult,
  child,
  connectDatabaseEmulator,
  enableLogging,
  endAt,
  endBefore,
  equalTo,
  get,
  getDatabase,
  goOffline,
  goOnline,
  increment,
  forceLongPolling,
  forceWebSockets,
  limitToFirst,
  limitToLast,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onDisconnect,
  onValue,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  push,
  pushKey,
  query,
  ref,
  refFromURL,
  remove,
  runTransaction,
  sandbox as databaseSandbox,
  serverTimestamp,
  set,
  setPriority,
  setWithPriority,
  startAfter,
  startAt,
  update,
  type DatabaseReference,
  type Query,
} from '../../../src/database/index.js';

export * from '../../../src/database/index.js';

export function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db, root: ref(db) };
}

export async function valueAt(path: string, initial?: unknown) {
  const { db } = setup();
  const target = ref(db, path);
  if (arguments.length > 1) await set(target, initial);
  return { db, target, snapshot: await get(target) };
}

export async function assertRoundTrip(value: unknown): Promise<void> {
  const { target } = await valueAt('value');
  await set(target, value);
  expect((await get(target)).val()).toEqual(value);
}

export async function assertSetReplacement(): Promise<void> {
  const { target } = await valueAt('value');
  await set(target, { a: 1, b: 2 });
  await set(target, { a: 3 });
  expect((await get(target)).val()).toEqual({ a: 3 });
}

export async function assertNullRemoval(useRemove = false): Promise<void> {
  const { target } = await valueAt('value', { child: true });
  await (useRemove ? remove(target) : set(target, null));
  const snap = await get(target);
  expect([snap.val(), snap.exists()]).toEqual([null, false]);
}

export async function assertUpdateMerge(): Promise<void> {
  const { target } = await valueAt('value', { keep: true, replace: 1 });
  await update(target, { replace: 2, added: true });
  expect((await get(target)).val()).toEqual({ keep: true, replace: 2, added: true });
}

export async function assertMultipath(): Promise<void> {
  const { root } = setup();
  await update(root, { 'a/x': 1, 'b/y': 2 });
  expect((await get(root)).val()).toEqual({ a: { x: 1 }, b: { y: 2 } });
}

export async function assertOverlappingUpdate(): Promise<void> {
  const { root } = setup();
  await set(root, { stable: true });
  expect(() => update(root, { a: 1, 'a/x': 2 })).toThrow();
  expect((await get(root)).val()).toEqual({ stable: true });
}

export async function assertPush(write: boolean): Promise<void> {
  const { db } = setup();
  const parent = ref(db, 'items');
  const pushed = write ? push(parent, { ok: true }) : push(parent);
  expect(pushed.key).toMatch(/^-.{19}$/);
  expect(typeof pushed.then).toBe('function');
  await pushed;
  expect((await get(pushed)).val()).toEqual(write ? { ok: true } : null);
}

export async function assertTimestamp(nested = false): Promise<void> {
  const { target } = await valueAt('clock');
  const marker = serverTimestamp();
  expect(marker).toEqual({ '.sv': 'timestamp' });
  await (nested ? update(target, { nested: marker }) : set(target, marker));
  const value = (await get(target)).val() as unknown;
  expect(typeof (nested ? (value as { nested: unknown }).nested : value)).toBe('number');
}

export async function assertDenied(operation: 'read' | 'write' | 'remove'): Promise<void> {
  const { db } = setup();
  databaseSandbox.setRules(db, { rules: { '.read': false, '.write': false } });
  const target = ref(db, 'denied');
  let error: unknown;
  try {
    if (operation === 'read') await get(target);
    else if (operation === 'remove') await remove(target);
    else await set(target, 1);
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe('PERMISSION_DENIED');
}

export async function assertValueListener(kind: 'initial' | 'missing' | 'change' | 'descendant' | 'unsubscribe' | 'onlyOnce') {
  const { db } = setup();
  const target = ref(db, 'watch');
  if (kind === 'initial') await set(target, { ready: true });
  const values: unknown[] = [];
  const unsubscribe = onValue(target, snap => values.push(snap.val()), kind === 'onlyOnce' ? { onlyOnce: true } : undefined);
  if (kind === 'change' || kind === 'unsubscribe' || kind === 'onlyOnce') await set(target, 1);
  if (kind === 'descendant') await set(child(target, 'nested'), true);
  if (kind === 'unsubscribe') { unsubscribe(); await set(target, 2); }
  if (kind === 'onlyOnce') await set(target, 2);
  if (kind === 'initial') expect(values).toEqual([{ ready: true }]);
  if (kind === 'missing') expect(values).toEqual([null]);
  if (kind === 'change') expect(values).toEqual([null, 1]);
  if (kind === 'descendant') expect(values).toEqual([null, { nested: true }]);
  if (kind === 'unsubscribe') expect(values).toEqual([null, 1]);
  if (kind === 'onlyOnce') expect(values).toEqual([null]);
  unsubscribe();
}

export async function assertChildEvent(kind: 'added' | 'changed' | 'removed' | 'moved' | 'no-change') {
  const { db } = setup();
  const parent = ref(db, 'children');
  await set(parent, { a: { score: 1 }, b: { score: 2 } });
  const events: Array<[string | null, unknown, string | null]> = [];
  const listener = kind === 'added' ? onChildAdded : kind === 'changed' || kind === 'no-change' ? onChildChanged : kind === 'removed' ? onChildRemoved : onChildMoved;
  const source = kind === 'moved' ? query(parent, orderByChild('score')) : parent;
  const unsubscribe = listener(source, (snap, previous) => events.push([snap.key, snap.val(), previous]));
  if (kind === 'added') await set(child(parent, 'c'), { score: 3 });
  if (kind === 'changed' || kind === 'no-change') { events.length = 0; await set(child(parent, kind === 'changed' ? 'a' : 'c'), kind === 'changed' ? { score: 4 } : { score: 3 }); }
  if (kind === 'removed') { events.length = 0; await remove(child(parent, 'a')); }
  if (kind === 'moved') { events.length = 0; await update(child(parent, 'a'), { score: 3 }); }
  if (kind === 'added') expect(events.map(e => e[0])).toEqual(['a', 'b', 'c']);
  if (kind === 'changed') expect(events).toHaveLength(1);
  if (kind === 'no-change') expect(events).toHaveLength(0);
  if (kind === 'removed') expect(events[0]?.slice(0, 2)).toEqual(['a', { score: 1 }]);
  if (kind === 'moved') expect(events[0]?.[0]).toBe('a');
  unsubscribe();
}

export function keys(snapshot: DataSnapshot): string[] {
  const result: string[] = [];
  snapshot.forEach(child => { if (child.key) result.push(child.key); return false; });
  return result;
}

export async function queryKeys(constraints: QueryConstraint[], data: unknown = {
  a: { score: 1, group: 'x' }, b: { score: 2, group: 'x' }, c: { score: 3, group: 'y' }, d: { score: 4, group: 'y' },
}): Promise<string[]> {
  const { db } = setup();
  const target = ref(db, 'rows');
  await set(target, data);
  return keys(await get(query(target, ...constraints)));
}

export async function assertTransaction(kind: 'commit' | 'abort' | 'clone' | 'listener' | 'denied' | 'serialized') {
  const { db } = setup();
  const target = ref(db, 'count');
  await set(target, kind === 'clone' ? { count: 1 } : 1);
  if (kind === 'denied') {
    databaseSandbox.setRules(db, { rules: { '.write': false, '.read': true } });
    await expect(runTransaction(target, () => 2)).rejects.toThrow('permission_denied');
    expect((await get(target)).val()).toBe(1);
    return;
  }
  const seen: unknown[] = [];
  const unsubscribe = kind === 'listener' ? onValue(target, snap => seen.push(snap.val())) : () => {};
  const result = await runTransaction(target, current => {
    if (kind === 'abort') return undefined;
    if (kind === 'clone') { (current as { count: number }).count++; return undefined; }
    return (current as number) + 1;
  });
  if (kind === 'abort' || kind === 'clone') expect(result.committed).toBe(false);
  else { expect(result).toBeInstanceOf(TransactionResult); expect(result.toJSON()).toEqual({ committed: true, snapshot: 2 }); }
  if (kind === 'clone') expect((await get(target)).val()).toEqual({ count: 1 });
  if (kind === 'listener') expect(seen.at(-1)).toBe(2);
  unsubscribe();
}

export async function assertReferenceShape(): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'a/b');
  expect([target.key, target.parent?.key, target.root.key]).toEqual(['b', 'a', null]);
  expect(target.toString()).toBe('sandbox://rtdb/a/b');
  expect(child(target.parent!, 'b').isEqual(target)).toBe(true);
}

export async function assertSnapshotShape(): Promise<void> {
  const { target } = await valueAt('shape', { a: 1, b: 2 });
  const snap = await get(target);
  expect(snap).toBeInstanceOf(DataSnapshot);
  expect([snap.size, snap.exists(), snap.hasChild('a'), snap.hasChildren(), snap.key]).toEqual([2, true, true, true, 'shape']);
  expect(snap.exportVal()).toEqual({ a: 1, b: 2 });
  expect(snap.toJSON()).toEqual({ a: 1, b: 2 });
  expect('numChildren' in snap).toBe(false);
}

export async function assertPriority(): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'priority');
  await setWithPriority(target, { a: 1 }, 4);
  expect((await get(target)).priority).toBe(4);
  await update(target, { b: 2 });
  expect((await get(target)).priority).toBe(4);
  await set(target, { c: 3 });
  expect((await get(target)).priority).toBeNull();
  await setPriority(target, null);
  expect((await get(target)).priority).toBeNull();
}

export async function assertDisconnect(kind: 'shape' | 'deferred' | 'once' | 'cancel' | 'priority') {
  const { db } = setup();
  const target = ref(db, 'presence');
  await set(target, { state: 'online' });
  const handle = onDisconnect(target);
  if (kind === 'shape') {
    expect(['cancel', 'remove', 'set', 'setWithPriority', 'update'].every(k => typeof handle[k as keyof typeof handle] === 'function')).toBe(true);
    expect(handle.cancel()).toBeInstanceOf(Promise);
    return;
  }
  if (kind === 'priority') await handle.setWithPriority('offline', 7);
  else await handle.set({ state: 'offline' });
  if (kind === 'cancel') await handle.cancel();
  expect((await get(target)).val()).toEqual({ state: 'online' });
  const { goOffline, goOnline } = await import('../../../src/database/index.js');
  goOffline(db);
  if (kind === 'cancel') expect((await get(target)).val()).toEqual({ state: 'online' });
  else if (kind === 'priority') expect([(await get(target)).val(), (await get(target)).priority]).toEqual(['offline', 7]);
  else expect((await get(target)).val()).toEqual({ state: 'offline' });
  if (kind === 'once') { goOnline(db); await set(target, 'again'); goOffline(db); expect((await get(target)).val()).toBe('again'); }
}

export function assertNoopControls(): void {
  const { db } = setup();
  expect(connectDatabaseEmulator(db, 'localhost', 9000)).toBeUndefined();
}

export const api = {
  Database, DataSnapshot, QueryConstraint, TransactionResult, child, endAt, endBefore, equalTo, get,
  connectDatabaseEmulator, enableLogging, forceLongPolling, forceWebSockets, getDatabase, goOffline, goOnline,
  increment, limitToFirst, limitToLast, off, onChildAdded, onChildChanged, onChildMoved,
  onChildRemoved, onDisconnect, onValue, orderByChild, orderByKey, orderByPriority, orderByValue, push,
  pushKey, query, ref, refFromURL, remove, runTransaction, serverTimestamp, set, setPriority,
  setWithPriority, startAfter, startAt, update, databaseSandbox,
};

export type { DatabaseReference, Query };
