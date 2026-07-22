import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
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
} from '../../src/database/index.js';

const OBS_DIR = join(
  import.meta.dir,
  '..', '..', '..', '..',
  'packages', 'conformance', 'observations', 'rtdb-modular',
);

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('onDisconnect registration and clean lifecycle', () => {
  it('rtdb-modular-ondisconnect-registration: exposes the captured handle and does not mutate data', async () => {
    const obs = load('rtdb-modular-ondisconnect-registration');
    const { db } = setup();
    const target = ref(db, 'presence/alice');
    await set(target, { state: 'online' });
    const handle = onDisconnect(target);

    expect(Object.keys(handle).sort()).toEqual(obs.ownKeys);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(handle)).filter((key) => key !== 'constructor').sort())
      .toEqual(obs.prototypeKeys);
    const methodTypes: Record<string, string> = {};
    for (const method of ['cancel', 'remove', 'set', 'setWithPriority', 'update'] as const) {
      methodTypes[method] = typeof handle[method];
    }
    expect(methodTypes).toEqual(obs.methodTypes);
    const returnThenables: Record<string, boolean> = {};
    for (const [name, call] of [
      ['set', () => handle.set({ state: 'offline' })],
      ['update', () => handle.update({ state: 'away' })],
      ['setWithPriority', () => handle.setWithPriority({ state: 'priority' }, 7)],
      ['remove', () => handle.remove()],
      ['cancel', () => handle.cancel()],
    ] as const) {
      const operation = call();
      returnThenables[name] = typeof operation.then === 'function';
      await operation;
    }
    expect(returnThenables).toEqual(obs.returnThenables);
    expect((await get(target)).val()).toEqual(obs.unchangedAfterRegistration);
  });

  it('rtdb-modular-ondisconnect-clean-set: drains once in captured listener order', async () => {
    const obs = load('rtdb-modular-ondisconnect-clean-set');
    const { db } = setup();
    const target = ref(db, 'presence/alice');
    const events: unknown[] = [];
    const unsubscribe = onValue(target, (snapshot) => events.push(snapshot.val()));
    await set(target, { state: 'online' });
    await onDisconnect(target).set({ state: 'offline' });
    expect((await get(target)).val()).toEqual(obs.beforeDisconnect);

    goOffline(db);
    expect((await get(target)).val()).toEqual(obs.afterDisconnect);
    goOnline(db);
    await set(target, { state: 'reconnected' });
    const secondDisconnectControl = ref(db, 'presence/alice/secondDisconnectControl');
    await onDisconnect(secondDisconnectControl).set({ drained: true });
    goOffline(db);
    goOnline(db);
    await set(secondDisconnectControl, null);
    expect((await get(target)).val()).toEqual(obs.terminalAfterReconnect);
    expect(events).toEqual(obs.events);
    expect(true).toBe(obs.secondDisconnectControlFired);
    unsubscribe();
  });

  it('rtdb-modular-ondisconnect-operations-cancel: matches captured operations and cancellation scope', async () => {
    const obs = load('rtdb-modular-ondisconnect-operations-cancel');
    const outcomes = obs.outcomes as Record<string, unknown>;
    const { db } = setup();
    const events: unknown[] = [];
    const unsubscribe = onValue(ref(db, 'root'), (snapshot) => events.push(snapshot.val()));
    await set(ref(db, 'root'), {
      set: 'before', update: { keep: true, value: 1 }, remove: true,
      cancelled: { original: true }, overlap: { original: true, child: 'original-child' },
      cancelScope: { child: 'original' }, nestedCancel: { a: { b: 'old', c: 'keep' } },
      nestedUpdateCancel: { a: { b: 'old', c: 'keep' }, stable: true },
      arrayCancel: ['zero', 'original-one', 'two'], timestamp: 0,
    });
    await onDisconnect(ref(db, 'root/set')).set(outcomes.set);
    await onDisconnect(ref(db, 'root/update')).update({ value: 2, added: true });
    await onDisconnect(ref(db, 'root/remove')).remove();
    const cancelled = onDisconnect(ref(db, 'root/cancelled'));
    await cancelled.set({ shouldNotApply: true });
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
    expect(value.set).toEqual(outcomes.set);
    expect(value.update).toEqual(outcomes.update);
    expect((await get(ref(db, 'root/remove'))).val()).toEqual(outcomes.remove);
    expect(value.cancelled).toEqual(outcomes.cancelledTerminal);
    expect(value.overlap).toEqual(outcomes.overlapAfterChildCancel);
    expect(value.cancelScope).toEqual(outcomes.parentCancelDescendantsTerminal);
    expect(value.nestedCancel).toEqual({ a: { b: 'old', c: 'keep' } });
    expect(value.nestedUpdateCancel).toEqual({ a: { b: 'old', c: 'keep' }, stable: true, changed: true });
    expect(value.arrayCancel).toEqual(['new-zero', 'original-one', 'new-two']);
    expect(typeof value.timestamp).toBe('number');
    expect(events.length > 1).toBe(obs.observerSawDisconnectEvents);
    unsubscribe();
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

  it('rtdb-modular-ondisconnect-rules: checks rules at registration and again at execution', async () => {
    const obs = load('rtdb-modular-ondisconnect-rules');
    const expectedNormalDenied = obs.normalDeniedControl as { resolved: boolean; error: { code: string } };
    const expectedRegistrationDenied = obs.registrationDenied as { resolved: boolean; error: { code: string } };
    const expectedNormalAllowed = obs.normalAllowedControl as { resolved: boolean; value: unknown };
    const expectedRegistered = obs.registeredWhileAllowed as { resolved: boolean; value: unknown };
    const { db } = setup();
    const target = ref(db, 'guarded/target');
    const drainControl = ref(db, 'guarded/drainControl');
    const drainEvents: unknown[] = [];
    const unsubscribe = onValue(drainControl, (snapshot) => drainEvents.push(snapshot.val()));
    rtdbSandbox.setRules(db, { rules: { guarded: { '.write': true, '.read': true } } });
    const normalAllowedValue = await set(target, 'seed');
    expect(true).toBe(expectedNormalAllowed.resolved);
    expect(normalAllowedValue ?? null).toBe(expectedNormalAllowed.value);
    const registeredValue = await onDisconnect(target).set('queued');
    expect(true).toBe(expectedRegistered.resolved);
    expect(registeredValue ?? null).toBe(expectedRegistered.value);
    await onDisconnect(drainControl).set('drained');
    rtdbSandbox.setRules(db, { rules: { guarded: {
      '.read': true,
      target: { '.write': false },
      drainControl: { '.write': true },
    } } });
    let normalDenied: unknown;
    try {
      await set(ref(db, 'guarded/normalDeniedControl'), 'denied');
    } catch (error) {
      normalDenied = error;
    }
    expect(normalDenied !== undefined).toBe(!expectedNormalDenied.resolved);
    expect(normalDenied).toMatchObject({ code: expectedNormalDenied.error.code });
    goOffline(db);
    expect((await get(drainControl)).exists()).toBe(obs.drainControlExecuted);
    expect(drainEvents.length > 1).toBe(obs.observerSawDrainControl);
    expect((await get(target)).val()).toBe(obs.terminalAfterExecutionDenial);
    let registrationDenied: unknown;
    try {
      await onDisconnect(target).set('denied');
    } catch (error) {
      registrationDenied = error;
    }
    expect(registrationDenied !== undefined).toBe(!expectedRegistrationDenied.resolved);
    expect(registrationDenied).toMatchObject({ code: expectedRegistrationDenied.error.code });
    unsubscribe();
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

  it('rtdb-modular#M83 writes the captured setWithPriority value and priority metadata', async () => {
    const obs = load('rtdb-modular-ondisconnect-operations-cancel');
    const production = (obs.outcomes as Record<string, Record<string, unknown>>).setWithPriority;
    const { db } = setup();
    const target = ref(db, 'priority');
    await onDisconnect(target).setWithPriority({ after: true }, 7);
    goOffline(db);
    const snapshot = await get(target);
    expect(snapshot.val()).toEqual({ after: production.after });
    expect(snapshot.priority).toBe(production['.priority']);
    expect(snapshot.exportVal()).toEqual(production);
  });
});

describe('onDisconnect app ownership', () => {
  beforeEach(() => resetAppRegistryForTests());
  afterEach(() => resetAppRegistryForTests());

  it('rtdb-modular#M82 keeps pending queues client-owned and ephemeral', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'first' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'second' }));
    const target = ref(first, 'presence/client');
    await set(target, 'online');
    await onDisconnect(target).set('offline');

    expect(rtdbSandbox.snapshotState(first)).toEqual({
      presence: { client: 'online' },
    });
    goOffline(second);
    expect((await get(target)).val()).toBe('online');
    sandbox.reset();
    goOffline(first);
    expect((await get(target)).val()).toBe('online');

    const app = initializeApp({ projectId: 'm82-app' }, 'm82-writer');
    const appTarget = ref(getDatabase(app), 'presence/app');
    await set(appTarget, 'online');
    await onDisconnect(appTarget).set('offline');
    await deleteApp(app);
    const observerApp = initializeApp({ projectId: 'm82-app' }, 'm82-observer');
    expect((await get(ref(getDatabase(observerApp), 'presence/app'))).val()).toBe('offline');
  });

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
