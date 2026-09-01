import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as api from '../../../src/database/index.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

const snapshotObservation = loadObservation('rtdb-modular-get-snapshot-shape');

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

export async function assertM70PushThenable(): Promise<void> {
  const db = setup();
  const target = api.ref(db, 'items');
  api.sandbox.setRules(db, { rules: { '.read': true, '.write': false } });
  const denied = api.push(target, { denied: true });
  expect(denied.key).toMatch(/^-.{19}$/);
  expect(denied.parent?.isEqual(target)).toBe(true);
  expect(typeof denied.then).toBe('function');
  expect(typeof denied.catch).toBe('function');
  const caught = await denied.catch(error => error as Error & { code?: string });
  expect(caught).toMatchObject({ name: 'Error', code: 'PERMISSION_DENIED' });
  await expect(Promise.resolve(denied)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

  api.sandbox.setRules(db, { rules: { '.read': true, '.write': true } });
  const allowed = api.push(target, { allowed: true });
  const resolved = await allowed;
  expect(resolved.isEqual(allowed)).toBe(true);
  expect((await api.get(allowed)).val()).toEqual({ allowed: true });
}

export async function assertM71SnapshotContract(): Promise<void> {
  const db = setup();
  const target = api.ref(db, 'parent');
  await api.set(target, { a: 1, b: 2, c: 3 });
  const snapshot = await api.get(target);
  const methods = ['val', 'exists', 'child', 'hasChild', 'hasChildren', 'forEach', 'exportVal', 'toJSON'];
  for (const method of methods) expect(typeof (snapshot as unknown as Record<string, unknown>)[method]).toBe('function');
  expect({
    hasVal: typeof snapshot.val === 'function',
    hasExists: typeof snapshot.exists === 'function',
    hasKey: 'key' in snapshot,
    hasRef: 'ref' in snapshot,
    hasSize: 'size' in snapshot,
    hasHasChildren: typeof snapshot.hasChildren === 'function',
    hasHasChild: typeof snapshot.hasChild === 'function',
    hasForEach: typeof snapshot.forEach === 'function',
    hasNumChildren: 'numChildren' in snapshot,
    size: snapshot.size,
    hasChildrenResult: snapshot.hasChildren(),
    existsResult: snapshot.exists(),
    val: snapshot.val(),
    forEachKeys: snapshotKeys(snapshot),
    key: snapshot.key,
  }).toEqual({
    hasVal: snapshotObservation.hasVal,
    hasExists: snapshotObservation.hasExists,
    hasKey: snapshotObservation.hasKey,
    hasRef: snapshotObservation.hasRef,
    hasSize: snapshotObservation.hasSize,
    hasHasChildren: snapshotObservation.hasHasChildren,
    hasHasChild: snapshotObservation.hasHasChild,
    hasForEach: snapshotObservation.hasForEach,
    hasNumChildren: snapshotObservation.hasNumChildren,
    size: snapshotObservation.size,
    hasChildrenResult: snapshotObservation.hasChildrenResult,
    existsResult: snapshotObservation.existsResult,
    val: snapshotObservation.val,
    forEachKeys: snapshotObservation.forEachKeys,
    key: snapshotObservation.key,
  });
  expect(snapshot.priority).toBeNull();
  expect(snapshot.ref.isEqual(target)).toBe(true);
  expect(snapshot.hasChild('a')).toBe(true);
  expect(snapshot.child('a').val()).toBe(1);
  expect(snapshot.exportVal()).toEqual(snapshotObservation.val);
  expect(snapshot.toJSON()).toEqual(snapshotObservation.val);
}
