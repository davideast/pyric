import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../../src/app/index.js';
import { resetAppRegistryForTests } from '../../../src/app/registry.js';
import {
  getDatabase,
  get,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  set,
  serverTimestamp,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('onDisconnect registration and clean lifecycle', () => {
  it('exposes promise-returning methods and registration does not mutate data', async () => {
    const { db } = setup();
    const target = ref(db, 'presence/alice');
    await set(target, { state: 'online' });
    const handle = onDisconnect(target);

    expect(Object.keys(handle).sort()).toEqual(['_path', '_repo']);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(handle)).filter((key) => key !== 'constructor').sort())
      .toEqual(['cancel', 'remove', 'set', 'setWithPriority', 'update']);
    for (const method of ['cancel', 'remove', 'set', 'setWithPriority', 'update'] as const) {
      expect(typeof handle[method]).toBe('function');
    }
    for (const operation of [
      handle.set({ state: 'offline' }),
      handle.update({ state: 'away' }),
      handle.setWithPriority({ state: 'priority' }, 7),
      handle.remove(),
      handle.cancel(),
    ]) {
      expect(typeof operation.then).toBe('function');
      await operation;
    }
    expect((await get(target)).val()).toEqual({ state: 'online' });
  });

  it('goOffline drains once in listener order and goOnline does not resurrect it', async () => {
    const { db } = setup();
    const target = ref(db, 'presence/alice');
    const events: unknown[] = [];
    const unsubscribe = onValue(target, (snapshot) => events.push(snapshot.val()));
    await set(target, { state: 'online' });
    await onDisconnect(target).set({ state: 'offline' });

    goOffline(db);
    expect(events).toEqual([null, { state: 'online' }, { state: 'offline' }]);
    goOnline(db);
    await set(target, { state: 'reconnected' });
    goOffline(db);
    expect((await get(target)).val()).toEqual({ state: 'reconnected' });
    unsubscribe();
  });

  it('supports set, update, remove, cancellation scope, and sentinel resolution', async () => {
    const { db } = setup();
    await set(ref(db, 'root'), {
      set: 'before', update: { keep: true, value: 1 }, remove: true,
      cancelled: 'before', overlap: { original: true, child: 'original-child' },
      cancelScope: { child: 'original' }, nestedCancel: { a: { b: 'old', c: 'keep' } },
      nestedUpdateCancel: { a: { b: 'old', c: 'keep' }, stable: true },
      arrayCancel: ['zero', 'original-one', 'two'], timestamp: 0,
    });
    await onDisconnect(ref(db, 'root/set')).set('after');
    await onDisconnect(ref(db, 'root/update')).update({ value: 2, added: true });
    await onDisconnect(ref(db, 'root/remove')).remove();
    const cancelled = onDisconnect(ref(db, 'root/cancelled'));
    await cancelled.set('after');
    await cancelled.cancel();
    await onDisconnect(ref(db, 'root/overlap')).set({ parent: true, child: 'parent-child' });
    await onDisconnect(ref(db, 'root/overlap/child')).set('child');
    await onDisconnect(ref(db, 'root/overlap/child')).cancel();
    await onDisconnect(ref(db, 'root/cancelScope/child')).set('queued-child');
    await onDisconnect(ref(db, 'root/cancelScope/child/grandchild')).set('queued-grandchild');
    await onDisconnect(ref(db, 'root/cancelScope')).cancel();
    await onDisconnect(ref(db, 'root/nestedCancel')).set({ a: { b: 'new' } });
    await onDisconnect(ref(db, 'root/nestedCancel/a/b')).set('child-write');
    await onDisconnect(ref(db, 'root/nestedCancel/a/b')).cancel();
    await onDisconnect(ref(db, 'root/nestedUpdateCancel')).update({ a: { b: 'new' }, changed: true });
    await onDisconnect(ref(db, 'root/nestedUpdateCancel/a/b')).set('child-write');
    await onDisconnect(ref(db, 'root/nestedUpdateCancel/a/b')).cancel();
    await onDisconnect(ref(db, 'root/arrayCancel')).set(['new-zero', 'new-one', 'new-two']);
    await onDisconnect(ref(db, 'root/arrayCancel/1')).set('child-write');
    await onDisconnect(ref(db, 'root/arrayCancel/1')).cancel();
    await onDisconnect(ref(db, 'root/timestamp')).set(serverTimestamp());

    goOffline(db);
    const value = (await get(ref(db, 'root'))).val() as Record<string, unknown>;
    expect(value.set).toBe('after');
    expect(value.update).toEqual({ keep: true, value: 2, added: true });
    expect(value.remove).toBeUndefined();
    expect(value.cancelled).toBe('before');
    expect(value.overlap).toEqual({ original: true, child: 'original-child', parent: true });
    expect(value.cancelScope).toEqual({ child: 'original' });
    expect(value.nestedCancel).toEqual({ a: { b: 'old', c: 'keep' } });
    expect(value.nestedUpdateCancel).toEqual({ a: { b: 'old', c: 'keep' }, stable: true, changed: true });
    expect(value.arrayCancel).toEqual(['new-zero', 'original-one', 'new-two']);
    expect(typeof value.timestamp).toBe('number');
  });

  it('keeps disconnect queues independent for clients sharing one tree', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    const target = ref(first, 'presence/alice');
    await set(target, 'online');
    await onDisconnect(target).set('offline');

    goOffline(second);
    expect((await get(target)).val()).toBe('online');
    goOffline(first);
    expect((await get(target)).val()).toBe('offline');
  });

  it('requires an online transition before a later goOffline can drain', async () => {
    const { db } = setup();
    const target = ref(db, 'presence/alice');
    goOffline(db);
    await onDisconnect(target).set('queued-while-offline');
    goOffline(db);
    expect((await get(target)).val()).toBeNull();
    goOnline(db);
    goOffline(db);
    expect((await get(target)).val()).toBe('queued-while-offline');
  });

  it('checks rules at registration and again at execution', async () => {
    const { db } = setup();
    const target = ref(db, 'guarded/target');
    const drainControl = ref(db, 'guarded/drainControl');
    rtdbSandbox.setRules(db, { rules: { guarded: { '.write': true, '.read': true } } });
    await set(target, 'seed');
    await onDisconnect(target).set('queued');
    await onDisconnect(drainControl).set('drained');
    rtdbSandbox.setRules(db, { rules: { guarded: {
      '.read': true,
      target: { '.write': false },
      drainControl: { '.write': true },
    } } });
    goOffline(db);
    expect((await get(drainControl)).val()).toBe('drained');
    expect((await get(target)).val()).toBe('seed');
    await expect(onDisconnect(target).set('denied')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('sandbox reset clears queued state without executing or persisting it', async () => {
    const { sandbox, db } = setup();
    const target = ref(db, 'presence/alice');
    await set(target, 'online');
    await onDisconnect(target).set('offline');
    const persisted = rtdbSandbox.snapshotState(db);
    expect(persisted).toEqual({ presence: { alice: 'online' } });

    sandbox.reset();
    goOffline(db);
    expect((await get(target)).val()).toBe('online');
  });

  it('writes the value but deliberately does not model priority metadata', async () => {
    const { db } = setup();
    const target = ref(db, 'priority');
    await onDisconnect(target).setWithPriority({ value: true }, 7);
    goOffline(db);
    const snapshot = await get(target);
    expect(snapshot.val()).toEqual({ value: true });
    expect(snapshot.priority).toBeNull();
  });
});

describe('onDisconnect app ownership', () => {
  afterEach(() => resetAppRegistryForTests());

  it('app deletion drains that app client queue', async () => {
    const app = initializeApp({ projectId: 'disconnect-app' }, 'disconnect-app');
    const db = getDatabase(app);
    const target = ref(db, 'presence/app');
    await set(target, 'online');
    await onDisconnect(target).set('offline');

    await deleteApp(app);
    const observerApp = initializeApp({ projectId: 'disconnect-app' }, 'observer');
    expect((await get(ref(getDatabase(observerApp), 'presence/app'))).val()).toBe('offline');
  });
});
