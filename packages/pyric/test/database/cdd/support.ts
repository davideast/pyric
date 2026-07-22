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
  await setWithPriority(child(target, 'a'), 1, 2);
  const prioritized = await get(target);
  expect(prioritized.priority).toBe(4);
  expect(prioritized.exportVal()).toEqual({ a: { '.value': 1, '.priority': 2 }, '.priority': 4 });
  expect(prioritized.toJSON()).toEqual({ a: { '.value': 1, '.priority': 2 }, '.priority': 4 });
  await update(target, { b: 2 });
  expect((await get(target)).priority).toBe(4);
  await set(target, { c: 3 });
  expect((await get(target)).priority).toBeNull();
  await setPriority(target, null);
  expect((await get(target)).priority).toBeNull();
}

export type DisconnectRegistrationObservation = {
  ownKeys: string[];
  prototypeKeys: string[];
  methodTypes: Record<string, string>;
  returnThenables: Record<string, boolean>;
  unchangedAfterRegistration: unknown;
};

export async function assertDisconnectRegistration(observation: DisconnectRegistrationObservation): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'presence');
  await set(target, { state: 'online' });
  const handle = onDisconnect(target);

  expect(Object.keys(handle).sort()).toEqual(observation.ownKeys);
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(handle))
    .filter(key => key !== 'constructor').sort()).toEqual(observation.prototypeKeys);

  const methodTypes: Record<string, string> = {};
  const returnThenables: Record<string, boolean> = {};
  for (const [name, operation] of [
    ['set', () => handle.set({ state: 'offline' })],
    ['update', () => handle.update({ state: 'away' })],
    ['setWithPriority', () => handle.setWithPriority({ state: 'priority' }, 7)],
    ['remove', () => handle.remove()],
    ['cancel', () => handle.cancel()],
  ] as const) {
    methodTypes[name] = typeof handle[name];
    const result = operation();
    returnThenables[name] = typeof result.then === 'function';
    await result;
  }

  expect(methodTypes).toEqual(observation.methodTypes);
  expect(returnThenables).toEqual(observation.returnThenables);
  expect((await get(target)).val()).toEqual(observation.unchangedAfterRegistration);
}

export async function assertDisconnectDeferred(unchangedAfterRegistration: unknown): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'presence');
  await set(target, unchangedAfterRegistration);
  await onDisconnect(target).set({ state: 'offline' });
  expect((await get(target)).val()).toEqual(unchangedAfterRegistration);
}

export type DisconnectCleanSetObservation = {
  events: unknown[];
  beforeDisconnect: unknown;
  afterDisconnect: unknown;
  terminalAfterReconnect: unknown;
  secondDisconnectControlFired: boolean;
};

export async function assertDisconnectCleanSet(observation: DisconnectCleanSetObservation): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'presence');
  const events: unknown[] = [];
  const unsubscribe = onValue(target, snapshot => events.push(snapshot.val()));
  await set(target, { state: 'online' });
  await onDisconnect(target).set({ state: 'offline' });
  expect((await get(target)).val()).toEqual(observation.beforeDisconnect);
  goOffline(db);
  expect((await get(target)).val()).toEqual(observation.afterDisconnect);
  goOnline(db);
  await set(target, { state: 'reconnected' });
  const control = child(target, 'secondDisconnectControl');
  await onDisconnect(control).set({ drained: true });
  goOffline(db);
  expect((await get(control)).exists()).toBe(observation.secondDisconnectControlFired);
  goOnline(db);
  await set(control, null);
  expect((await get(target)).val()).toEqual(observation.terminalAfterReconnect);
  expect(events).toEqual(observation.events);
  unsubscribe();
}

export type DisconnectOperationOutcomes = {
  set: unknown;
  update: unknown;
  remove: unknown;
  overlapAfterChildCancel: unknown;
  parentCancelDescendantsTerminal: unknown;
  cancelledTerminal: unknown;
};

export async function assertDisconnectOperations(
  outcomes: DisconnectOperationOutcomes,
  observerSawDisconnectEvents: boolean,
): Promise<void> {
  const { db } = setup();
  const root = ref(db, 'disconnect-operations');
  const events: unknown[] = [];
  const unsubscribe = onValue(root, snapshot => events.push(snapshot.val()));
  await set(root, {
    set: 'before',
    update: { keep: true, value: 1 },
    remove: true,
    cancelled: { original: true },
    overlap: { original: true, child: 'original-child' },
    cancelScope: { child: 'original' },
  });

  await onDisconnect(child(root, 'set')).set(outcomes.set);
  await onDisconnect(child(root, 'update')).update({ value: 2, added: true });
  await onDisconnect(child(root, 'remove')).remove();
  const exactCancellation = onDisconnect(child(root, 'cancelled'));
  await exactCancellation.set({ shouldNotApply: true });
  await exactCancellation.cancel();
  await onDisconnect(child(root, 'overlap')).set({ parent: true, child: 'parent-child' });
  await onDisconnect(child(root, 'overlap/child')).set('child-write');
  await onDisconnect(child(root, 'overlap/child')).cancel();
  await onDisconnect(child(root, 'cancelScope/child')).set('queued-child');
  await onDisconnect(child(root, 'cancelScope/child/grandchild')).set('queued-grandchild');
  await onDisconnect(child(root, 'cancelScope')).cancel();

  goOffline(db);
  const terminal = (await get(root)).val() as Record<string, unknown>;
  expect(terminal.set).toEqual(outcomes.set);
  expect(terminal.update).toEqual(outcomes.update);
  expect(terminal.remove ?? null).toEqual(outcomes.remove);
  expect(terminal.cancelled).toEqual(outcomes.cancelledTerminal);
  expect(terminal.overlap).toEqual(outcomes.overlapAfterChildCancel);
  expect(terminal.cancelScope).toEqual(outcomes.parentCancelDescendantsTerminal);
  expect(events.length > 1).toBe(observerSawDisconnectEvents);
  unsubscribe();
}

export type DisconnectRulesObservation = {
  normalDeniedControl: { resolved: boolean; error: { code: string; name: string } };
  registrationDenied: { resolved: boolean; error: { code: string; name: string } };
  normalAllowedControl: { resolved: boolean; value: unknown };
  registeredWhileAllowed: { resolved: boolean; value: unknown };
  drainControlExecuted: boolean;
  observerSawDrainControl: boolean;
  terminalAfterExecutionDenial: unknown;
};

export async function assertDisconnectRules(observation: DisconnectRulesObservation): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'guarded/target');
  const drainControl = ref(db, 'guarded/drainControl');
  const drainEvents: unknown[] = [];
  const unsubscribe = onValue(drainControl, snapshot => drainEvents.push(snapshot.val()));
  databaseSandbox.setRules(db, { rules: { guarded: { '.write': true, '.read': true } } });

  const allowed = await set(target, 'seed');
  expect(observation.normalAllowedControl.resolved).toBe(true);
  expect(allowed ?? null).toBe(observation.normalAllowedControl.value);
  const registered = await onDisconnect(target).set('queued');
  expect(observation.registeredWhileAllowed.resolved).toBe(true);
  expect(registered ?? null).toBe(observation.registeredWhileAllowed.value);
  await onDisconnect(drainControl).set('drained');

  databaseSandbox.setRules(db, { rules: { guarded: {
    '.read': true,
    target: { '.write': false },
    drainControl: { '.write': true },
  } } });
  let normalDenied: unknown;
  try { await set(ref(db, 'guarded/normalDeniedControl'), 'denied'); } catch (error) { normalDenied = error; }
  expect(normalDenied !== undefined).toBe(!observation.normalDeniedControl.resolved);
  expect(normalDenied).toMatchObject(observation.normalDeniedControl.error);

  goOffline(db);
  expect((await get(drainControl)).exists()).toBe(observation.drainControlExecuted);
  expect(drainEvents.length > 1).toBe(observation.observerSawDrainControl);
  expect((await get(target)).val()).toBe(observation.terminalAfterExecutionDenial);

  let registrationDenied: unknown;
  try { await onDisconnect(target).set('denied'); } catch (error) { registrationDenied = error; }
  expect(registrationDenied !== undefined).toBe(!observation.registrationDenied.resolved);
  expect(registrationDenied).toMatchObject(observation.registrationDenied.error);
  unsubscribe();
}

export async function assertDisconnectPriority(productionExport: Record<string, unknown>): Promise<void> {
  const { db } = setup();
  const target = ref(db, 'priority');
  await onDisconnect(target).setWithPriority({ after: true }, 7);
  goOffline(db);
  const snapshot = await get(target);
  expect(snapshot.val()).toEqual({ after: productionExport.after });
  expect(snapshot.priority).toBe(productionExport['.priority']);
  expect(snapshot.exportVal()).toEqual(productionExport);
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
