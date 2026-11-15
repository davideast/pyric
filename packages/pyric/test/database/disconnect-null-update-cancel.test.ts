import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  goOffline,
  onDisconnect,
  ref,
  sandbox as rtdbSandbox,
  set,
} from '../../src/database/index.js';
import { DisconnectOperationQueue } from '../../src/database/disconnect-operation-queue.js';

describe('onDisconnect().update() null removal cancellation', () => {
  test('cancels a queued null removal entry when cancelled at the child path', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'rooms/r1'), { a: 1, b: 2 });
    await onDisconnect(ref(db, 'rooms/r1')).update({ a: null });
    await onDisconnect(ref(db, 'rooms/r1/a')).cancel();

    goOffline(db);

    const snapshot = await get(ref(db, 'rooms/r1'));
    expect(snapshot.val()).toEqual({ a: 1, b: 2 });
  });

  test('preserves a sibling null removal when another update child is cancelled', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'rooms/r2'), { a: 1, b: 2 });
    await onDisconnect(ref(db, 'rooms/r2')).update({ a: null, b: 99 });
    await onDisconnect(ref(db, 'rooms/r2/b')).cancel();

    goOffline(db);

    const snapshot = await get(ref(db, 'rooms/r2'));
    expect(snapshot.val()).toEqual({ b: 2 });
  });

  test('cancels and preserves multi-segment null update paths accurately', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'rooms/r3'), { a: { x: 1, y: 2 }, c: { z: 3 }, keep: true });
    await onDisconnect(ref(db, 'rooms/r3')).update({ 'a/x': null, 'c/z': null, keep: false });
    await onDisconnect(ref(db, 'rooms/r3/a')).cancel();
    await onDisconnect(ref(db, 'rooms/r3/keep')).cancel();

    goOffline(db);

    const snapshot = await get(ref(db, 'rooms/r3'));
    expect(snapshot.val()).toEqual({ a: { x: 1, y: 2 }, keep: true });
  });

  test('does not materialize nested null keys inside an object value as deletions when unfolding', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'rooms/r4'), { a: { x: 1, y: 2 }, keep: true });
    await onDisconnect(ref(db, 'rooms/r4')).update({ a: { x: null, y: 9 } });
    await onDisconnect(ref(db, 'rooms/r4/a/y')).cancel();

    goOffline(db);

    const snapshot = await get(ref(db, 'rooms/r4'));
    expect(snapshot.val()).toEqual({ a: { x: 1, y: 2 }, keep: true });
  });

  test('does not materialize null keys inside a set payload as deletions when unfolding', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'rooms/r5'), { a: 1, b: 2 });
    await onDisconnect(ref(db, 'rooms/r5')).set({ a: null, b: 9 });
    await onDisconnect(ref(db, 'rooms/r5/b')).cancel();

    goOffline(db);

    const snapshot = await get(ref(db, 'rooms/r5'));
    expect(snapshot.val()).toEqual({ a: 1, b: 2 });
  });
});

describe('DisconnectOperationQueue null update cancellation invariants', () => {
  test('removes a lone null update entry when cancelled at its child path', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'update', path: '/rooms/r1', values: { a: null }, actor: 'u1' });
    queue.cancel('/rooms/r1/a');
    expect(queue.takeAll()).toEqual([]);
  });

  test('retains sibling null update entries when an unrelated sibling is cancelled', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'update', path: '/rooms/r2', values: { a: null, b: 99 }, actor: 'u1' });
    queue.cancel('/rooms/r2/b');
    expect(queue.takeAll()).toEqual([
      { kind: 'update', path: '/rooms/r2', values: { a: null }, actor: 'u1' },
    ]);
  });

  test('keeps a null update entry intact when cancelling a deeper descendant path', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'update', path: '/rooms/r3', values: { a: null, b: 2 }, actor: 'u1' });
    queue.cancel('/rooms/r3/a/sub');
    expect(queue.takeAll()).toEqual([
      { kind: 'update', path: '/rooms/r3', values: { a: null, b: 2 }, actor: 'u1' },
    ]);
  });

  test('cancels multi-segment null entries by ancestor or exact path while preserving other null entries', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({
      kind: 'update',
      path: '/rooms/r4',
      values: { 'a/x': null, 'b/y': null, c: 1 },
      actor: 'u1',
    });
    queue.cancel('/rooms/r4/a');
    queue.cancel('/rooms/r4/c');
    expect(queue.takeAll()).toEqual([
      { kind: 'update', path: '/rooms/r4', values: { 'b/y': null }, actor: 'u1' },
    ]);
  });
});
