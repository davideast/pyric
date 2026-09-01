import { expect } from 'bun:test';
import {
  child,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  ref,
  remove,
  set,
  setPriority,
  setWithPriority,
} from '../../../src/database/index.js';
import { setup } from './support.js';

export async function assertChangedChildContract(): Promise<void> {
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
  const { sandbox, db } = setup();
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
