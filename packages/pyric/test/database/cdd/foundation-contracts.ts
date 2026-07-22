import { expect } from 'bun:test';
import { FirebaseError } from '../../../src/app/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  TARGET_SYMBOL,
  child,
  get,
  getDatabase,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  ref,
  remove,
  runTransaction,
  sandbox as databaseSandbox,
  set,
  setPriority,
  setWithPriority,
} from '../../../src/database/index.js';

type DeniedOperation = 'read' | 'write' | 'remove';

export async function assertFrozenIdentityRouting(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  expect(db[TARGET_SYMBOL].kind).toBe('sandbox');
  databaseSandbox.setRules(db, {
    rules: { users: { '$uid': { '.read': '$uid === auth.uid', '.write': '$uid === auth.uid' } } },
  });

  sandbox.currentUser = { uid: 'bob' };
  await set(ref(db, 'users/alice/value'), 1);
  expect((await get(ref(db, 'users/alice/value'))).val()).toBe(1);
  await expect(set(ref(db, 'users/bob/value'), 2)).rejects.toThrow('PERMISSION_DENIED');
}

export async function assertLiveIdentityRouting(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  expect(db[TARGET_SYMBOL].kind).toBe('sandbox-live');
  databaseSandbox.setRules(db, {
    rules: { users: { '$uid': { '.read': '$uid === auth.uid', '.write': '$uid === auth.uid' } } },
  });

  await expect(set(ref(db, 'users/alice/value'), 1)).rejects.toThrow('PERMISSION_DENIED');
  sandbox.currentUser = { uid: 'alice' };
  await set(ref(db, 'users/alice/value'), 1);
  sandbox.currentUser = { uid: 'bob' };
  await expect(get(ref(db, 'users/alice/value'))).rejects.toThrow('PERMISSION_DENIED');
  await set(ref(db, 'users/bob/value'), 2);
}

export async function assertDatabaseBackendIdentity(): Promise<void> {
  const firstSandbox = initializeSandbox();
  const secondSandbox = initializeSandbox();
  const first = getDatabase(firstSandbox);
  const sibling = getDatabase(firstSandbox);
  const isolated = getDatabase(secondSandbox);

  await set(ref(first, 'shared/value'), 1);
  expect((await get(ref(sibling, 'shared/value'))).val()).toBe(1);
  expect((await get(ref(isolated, 'shared/value'))).val()).toBeNull();
  await set(ref(isolated, 'shared/value'), 2);
  expect((await get(ref(first, 'shared/value'))).val()).toBe(1);
  expect((await get(ref(isolated, 'shared/value'))).val()).toBe(2);
}

export async function assertDeniedErrorEnvelope(operation: DeniedOperation): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': false, '.write': false } });
  const target = ref(db, 'denied');
  let caught: unknown;
  try {
    if (operation === 'read') await get(target);
    else if (operation === 'remove') await remove(target);
    else await set(target, 1);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(FirebaseError);
  const error = caught as Error & { code?: string };
  expect({
    code: error.code,
    message: error.message,
    errorName: error.name,
    constructorName: error.constructor.name,
    isErrorInstance: error instanceof Error,
  }).toEqual({
    code: 'PERMISSION_DENIED',
    message: 'PERMISSION_DENIED: Permission denied',
    errorName: 'Error',
    constructorName: 'Error',
    isErrorInstance: true,
  });
}

export function assertMissingValueListener(): void {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const events: Array<{ value: unknown; exists: boolean }> = [];
  const unsubscribe = onValue(ref(db, 'missing'), snapshot => events.push({
    value: snapshot.val(),
    exists: snapshot.exists(),
  }));
  expect(events).toEqual([{ value: null, exists: false }]);
  unsubscribe();
}

export async function assertSetDataBypassesRules(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': true, '.write': false } });
  await expect(set(ref(db, 'blocked'), 1)).rejects.toThrow('PERMISSION_DENIED');
  databaseSandbox.setData(db, { '/seeded': { nested: true } });
  expect(databaseSandbox.snapshotState(db)).toEqual({ seeded: { nested: true } });
  expect((await get(ref(db, 'seeded'))).val()).toEqual({ nested: true });
}

export async function assertChangedChildContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await set(parent, { k1: { v: 1 }, k2: { v: 2 } });
  const events: Array<{ key: string | null; value: unknown }> = [];
  const unsubscribe = onChildChanged(parent, snapshot => events.push({ key: snapshot.key, value: snapshot.val() }));
  expect(events).toEqual([]);
  await set(child(parent, 'k1'), { v: 2 });
  expect(events).toEqual([{ key: 'k1', value: { v: 2 } }]);
  await set(child(parent, 'k1'), { v: 2 });
  expect(events).toHaveLength(1);
  unsubscribe();
}

export async function assertInitialAddedChildrenContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await set(parent, { k1: { v: 1 }, k2: { v: 2 }, k3: { v: 3 } });
  const events: Array<{ key: string | null; value: unknown }> = [];
  const unsubscribe = onChildAdded(parent, snapshot => events.push({ key: snapshot.key, value: snapshot.val() }));
  expect(events).toEqual([
    { key: 'k1', value: { v: 1 } },
    { key: 'k2', value: { v: 2 } },
    { key: 'k3', value: { v: 3 } },
  ]);
  unsubscribe();
}

export async function assertPostSubscribeAddedChildContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await set(parent, { k1: { v: 1 }, k2: { v: 2 } });
  const events: Array<{ key: string | null; value: unknown }> = [];
  const unsubscribe = onChildAdded(parent, snapshot => events.push({ key: snapshot.key, value: snapshot.val() }));
  events.length = 0;
  await set(child(parent, 'k3'), { v: 3 });
  expect(events).toEqual([{ key: 'k3', value: { v: 3 } }]);
  await set(child(parent, 'k3'), { v: 4 });
  expect(events).toHaveLength(1);
  unsubscribe();
}

export async function assertChangedChildExcludesAddsAndRemovals(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await set(parent, { existing: { v: 1 } });
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unsubChanged = onChildChanged(parent, snapshot => changed.push(snapshot.key!));
  const unsubAdded = onChildAdded(parent, snapshot => added.push(snapshot.key!));
  const unsubRemoved = onChildRemoved(parent, snapshot => removed.push(snapshot.key!));
  added.length = 0;
  await set(child(parent, 'new'), { v: 2 });
  await remove(child(parent, 'existing'));
  expect(changed).toEqual([]);
  expect(added).toEqual(['new']);
  expect(removed).toEqual(['existing']);
  unsubChanged(); unsubAdded(); unsubRemoved();
}

export async function assertRemovedChildContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await set(parent, { byRemove: { v: 1 }, byNull: { v: 2 } });
  const events: Array<{ key: string | null; value: unknown }> = [];
  const unsubscribe = onChildRemoved(parent, snapshot => events.push({ key: snapshot.key, value: snapshot.val() }));
  expect(events).toEqual([]);
  await remove(child(parent, 'byRemove'));
  await set(child(parent, 'byNull'), null);
  expect(events).toEqual([
    { key: 'byRemove', value: { v: 1 } },
    { key: 'byNull', value: { v: 2 } },
  ]);
  unsubscribe();
}

export async function assertMovedChildContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await setWithPriority(child(parent, 'a'), { v: 1 }, 1);
  await setWithPriority(child(parent, 'b'), { v: 2 }, 2);
  const moved: Array<{ key: string | null; previous: string | null }> = [];
  const unsubscribe = onChildMoved(parent, (snapshot, previous) => moved.push({ key: snapshot.key, previous }));
  await set(child(parent, 'a/v'), 10);
  expect(moved).toEqual([]);
  await setPriority(child(parent, 'a'), 3);
  expect(moved).toEqual([{ key: 'a', previous: 'b' }]);
  await setPriority(child(parent, 'a'), 4);
  expect(moved).toEqual([
    { key: 'a', previous: 'b' },
    { key: 'a', previous: 'b' },
  ]);
  unsubscribe();
}

export async function assertOffRemovesEveryListenerVariety(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  await setWithPriority(child(parent, 'a'), { v: 1 }, 1);
  await setWithPriority(child(parent, 'b'), { v: 2 }, 2);
  const counts = { value: 0, added: 0, changed: 0, removed: 0, moved: 0 };
  onValue(parent, () => { counts.value += 1; });
  onChildAdded(parent, () => { counts.added += 1; });
  onChildChanged(parent, () => { counts.changed += 1; });
  onChildRemoved(parent, () => { counts.removed += 1; });
  onChildMoved(parent, () => { counts.moved += 1; });
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
  off(parent);
  await set(child(parent, 'a'), { v: 10 });
  await set(child(parent, 'c'), { v: 3 });
  await remove(child(parent, 'b'));
  await setPriority(child(parent, 'a'), 4);
  expect(counts).toEqual({ value: 0, added: 0, changed: 0, removed: 0, moved: 0 });
}

export async function assertTargetedOffAndUnsubscribe(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const parent = ref(db, 'parent');
  const calls = {
    valueA: 0,
    valueB: 0,
    addedA: 0,
    addedB: 0,
    changed: 0,
    removedA: 0,
    removedB: 0,
  };
  const valueA = () => { calls.valueA += 1; };
  const valueB = () => { calls.valueB += 1; };
  const addedA = () => { calls.addedA += 1; };
  const addedB = () => { calls.addedB += 1; };
  onValue(parent, valueA); onValue(parent, valueB);
  onChildAdded(parent, addedA); onChildAdded(parent, addedB);
  onChildChanged(parent, () => { calls.changed += 1; });
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;

  off(parent, 'value', valueA);
  off(parent, 'child_added', addedA);
  await set(child(parent, 'a'), 1);
  expect(calls).toEqual({
    valueA: 0, valueB: 1, addedA: 0, addedB: 1, changed: 0, removedA: 0, removedB: 0,
  });

  off(parent, 'value');
  off(parent, 'child_added');
  await set(child(parent, 'a'), 2);
  expect(calls).toEqual({
    valueA: 0, valueB: 1, addedA: 0, addedB: 1, changed: 1, removedA: 0, removedB: 0,
  });

  const unsubscribe = onChildRemoved(parent, () => { calls.removedA += 1; });
  onChildRemoved(parent, () => { calls.removedB += 1; });
  unsubscribe();
  await remove(child(parent, 'a'));
  expect([calls.removedA, calls.removedB]).toEqual([0, 1]);
  off(parent);
}

export async function assertTransactionAbortContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const target = ref(db, 'counter');
  await set(target, 100);
  const events: unknown[] = [];
  const unsubscribe = onValue(target, snapshot => events.push(snapshot.val()));
  const result = await runTransaction(target, () => undefined);
  expect(result.committed).toBe(false);
  expect(result.snapshot.val()).toBe(100);
  expect((await get(target)).val()).toBe(100);
  expect(events).toEqual([100]);
  unsubscribe();
}

export async function assertApplyLocallyContract(): Promise<void> {
  for (const applyLocally of [true, false]) {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const target = ref(db, 'counter');
    await set(target, 1);
    const events: unknown[] = [];
    const unsubscribe = onValue(target, snapshot => events.push(snapshot.val()));
    const result = await runTransaction(target, current => (current as number) + 10, { applyLocally });
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(11);
    expect((await get(target)).val()).toBe(11);
    expect(events).toEqual([1, 11]);
    unsubscribe();
  }
}

export async function assertDeniedTransactionEnvelope(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': false, '.write': false } });
  let updateFnCallCount = 0;
  let caught: unknown;
  let resolved: unknown = null;
  try {
    resolved = await runTransaction(ref(db, 'denied'), () => {
      updateFnCallCount += 1;
      return 1;
    });
  } catch (error) {
    caught = error;
  }
  expect(resolved).toBeNull();
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(FirebaseError);
  const error = caught as Error & { code?: unknown };
  expect({
    code: error.code ?? null,
    hasCode: 'code' in error,
    message: error.message,
    errorName: error.name,
    constructorName: error.constructor.name,
    isErrorInstance: error instanceof Error,
    updateFnCallCount,
  }).toEqual({
    code: null,
    hasCode: false,
    message: 'permission_denied',
    errorName: 'Error',
    constructorName: 'Error',
    isErrorInstance: true,
    updateFnCallCount: 1,
  });
}

export async function assertTransactionContentionBoundary(): Promise<void> {
  const sandbox = initializeSandbox();
  const first = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const second = getDatabase(sandbox.withAuth({ uid: 'bob' }));
  const target = ref(first, 'counter');
  await set(target, 0);
  const calls = [0, 0];
  const results = await Promise.all([
    runTransaction(target, current => { calls[0] += 1; return (current as number) + 1; }),
    runTransaction(ref(second, 'counter'), current => { calls[1] += 1; return (current as number) + 1; }),
  ]);
  expect(calls).toEqual([1, 1]);
  expect(calls).not.toEqual([2, 3]);
  expect(results.map(result => result.committed)).toEqual([true, true]);
  expect(results.map(result => result.snapshot.val()).sort()).toEqual([1, 2]);
  expect((await get(target)).val()).toBe(2);

  let injected = false;
  const seen: unknown[] = [];
  const retryTarget = ref(first, 'retry');
  await set(retryTarget, 0);
  const retried = await runTransaction(retryTarget, current => {
    seen.push(current);
    if (!injected) {
      injected = true;
      void set(ref(second, 'retry'), 10);
    }
    return (current as number) + 1;
  });
  expect(seen).toEqual([0, 10]);
  expect(retried.committed).toBe(true);
  expect(retried.snapshot.val()).toBe(11);
}
