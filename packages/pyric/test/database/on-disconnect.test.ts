import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
import {
  getAdminDatabase,
  getDatabase,
  get,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  set,
  serverTimestamp,
  increment,
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
  rtdbSandbox.setDefaultPolicy(db, 'allow');
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

  it('keeps a queued server value whole when a path below it is cancelled', async () => {
    const { db } = setup();
    await set(ref(db, 'counter'), 5);
    await onDisconnect(ref(db, 'stamp')).set(serverTimestamp());
    await onDisconnect(ref(db, 'stamp/c')).cancel();
    await onDisconnect(ref(db, 'counter')).set(increment(2));
    await onDisconnect(ref(db, 'counter/c')).cancel();
    goOffline(db);
    const value = (await get(ref(db, '/'))).val() as Record<string, unknown>;
    // A server value is a leaf: there is no child below it to cancel.
    expect(typeof value.stamp).toBe('number');
    expect(value.counter).toBe(7);
  });

  it('keeps disconnect queues independent for clients sharing one tree', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setDefaultPolicy(first, 'allow');
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

  it('cancelling a child that was never queued keeps a parent set whole so a tightened parent .write denies it (#1021)', async () => {
    const app = initializeSandbox();
    const db = getDatabase(app);
    const admin = getAdminDatabase(app);
    const tight = "root.child('flags').child('tight').val() != true";
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': true,
        doc: { '.write': tight, $k: { '.write': true } },
      },
    });
    await set(ref(admin, 'doc'), { a: 1, keep: 'x' });
    await set(ref(admin, 'flags/tight'), false);
    await onDisconnect(ref(db, 'doc')).set({ a: 2 });
    await onDisconnect(ref(db, 'doc/neverQueued')).cancel();
    await set(ref(admin, 'flags/tight'), true);
    goOffline(db);
    expect((await get(ref(admin, 'doc'))).exportVal()).toEqual({ a: 1, keep: 'x' });
  });

  it('cancelling a child that was never queued keeps a parent setWithPriority whole, removing siblings and keeping priority (#1021)', async () => {
    const app = initializeSandbox();
    const db = getDatabase(app);
    const admin = getAdminDatabase(app);
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(admin, 'doc'), { a: 1, keep: 'x' });
    await onDisconnect(ref(db, 'doc')).setWithPriority({ a: 2 }, 9);
    await onDisconnect(ref(db, 'doc/neverQueued')).cancel();
    goOffline(db);
    expect((await get(ref(admin, 'doc'))).exportVal()).toEqual({ a: 2, '.priority': 9 });
  });

  it('re-registering a parent remove or set replaces a queued descendant operation (#1021)', async () => {
    for (const last of ['remove', 'set'] as const) {
      const app = initializeSandbox();
      const db = getDatabase(app);
      const admin = getAdminDatabase(app);
      rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
      await onDisconnect(ref(db, 'pres')).set({ status: 'first' });
      await onDisconnect(ref(db, 'pres/sub')).set('stale-child');
      let expected: unknown = { status: 'second' };
      if (last === 'remove') {
        await onDisconnect(ref(db, 'pres')).remove();
        expected = null;
      } else {
        await onDisconnect(ref(db, 'pres')).set({ status: 'second' });
      }
      goOffline(db);
      expect((await get(ref(admin, 'pres'))).exportVal()).toEqual(expected);
    }
  });

  // Production capture 2026-10-17 on pyric-oracle-rtdb with firebase@12.13.0
  // (probe-ondisconnect-edge: E1, E1B, E1R, E2, E2N, C1, C2, C3):
  // - cancel(path) addressing a node inside a queued set value, or a queued
  //   child op, splits that set into a deep per-leaf merge with the cancelled
  //   node pruned, keeping the parent's priority (E1, E1B, C1) and evaluating
  //   child .write rules at disconnect (E1R).
  // - cancel(path) addressing a nested node inside a queued update (or set)
  //   unfolds that branch into a deep per-leaf merge so existing siblings under
  //   the nested branch survive (E2N).
  // - cancel(path) outside the queued value leaves set and update whole (C2, C3).
  it('cancelling a path inside a queued set value or after a queued child op splits the set into a merge while keeping parent priority and checking child .write rules', async () => {
    const app = initializeSandbox();
    const db = getDatabase(app);
    const admin = getAdminDatabase(app);
    const tight = "root.child('flags').child('tight').val() != true";
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': true,
        e1: { '.write': true },
        e1b: { '.write': true },
        e1r: { doc: { '.write': tight, $k: { '.write': true } } },
        c1: { '.write': true },
        c2: { '.write': true },
      },
    });
    await set(ref(admin, 'e1/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'e1b/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'e1r/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'c1/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'c2/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'flags/tight'), false);

    // E1: setWithPriority({a:2, b:3}, 9) + cancel('doc/b') (no separate child op)
    await onDisconnect(ref(db, 'e1/doc')).setWithPriority({ a: 2, b: 3 }, 9);
    await onDisconnect(ref(db, 'e1/doc/b')).cancel();

    // E1B: set({a:2, b:3}) + cancel('doc/b')
    await onDisconnect(ref(db, 'e1b/doc')).set({ a: 2, b: 3 });
    await onDisconnect(ref(db, 'e1b/doc/b')).cancel();

    // E1R: set({a:2, b:3}) + cancel('doc/b'), then tighten parent .write to false
    await onDisconnect(ref(db, 'e1r/doc')).set({ a: 2, b: 3 });
    await onDisconnect(ref(db, 'e1r/doc/b')).cancel();

    // C1: setWithPriority({a:2, b:3}, 9) + child set('doc/b', 30) + cancel('doc/b')
    await onDisconnect(ref(db, 'c1/doc')).setWithPriority({ a: 2, b: 3 }, 9);
    await onDisconnect(ref(db, 'c1/doc/b')).set(30);
    await onDisconnect(ref(db, 'c1/doc/b')).cancel();

    // C2: setWithPriority({a:2, b:3}, 9) + cancel('doc/neverQueued')
    await onDisconnect(ref(db, 'c2/doc')).setWithPriority({ a: 2, b: 3 }, 9);
    await onDisconnect(ref(db, 'c2/doc/neverQueued')).cancel();

    await set(ref(admin, 'flags/tight'), true);
    goOffline(db);

    expect((await get(ref(admin, 'e1/doc'))).exportVal()).toEqual({
      '.priority': 9,
      a: 2,
      b: 1,
      keep: 'x',
    });
    expect((await get(ref(admin, 'e1b/doc'))).exportVal()).toEqual({
      a: 2,
      b: 1,
      keep: 'x',
    });
    expect((await get(ref(admin, 'e1r/doc'))).exportVal()).toEqual({
      a: 2,
      b: 1,
      keep: 'x',
    });
    expect((await get(ref(admin, 'c1/doc'))).exportVal()).toEqual({
      '.priority': 9,
      a: 2,
      b: 1,
      keep: 'x',
    });
    expect((await get(ref(admin, 'c2/doc'))).exportVal()).toEqual({
      '.priority': 9,
      a: 2,
      b: 3,
    });
  });

  it('cancelling a nested path inside a queued update or set unfolds that branch into a deep merge keeping existing siblings', async () => {
    const app = initializeSandbox();
    const db = getDatabase(app);
    const admin = getAdminDatabase(app);
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(admin, 'e2/doc'), { a: 1, b: 1, keep: 'x' });
    await set(ref(admin, 'e2n/doc'), { a: { x: 1, y: 1, keep: 'x' }, b: 1 });
    await set(ref(admin, 'setNested/doc'), { a: { x: 1, y: 1, keep: 'x' }, b: 1, topKeep: 'z' });
    await set(ref(admin, 'c3/doc'), { a: 1, b: 1, keep: 'x' });

    // E2: update({a:2, b:3}) + cancel('doc/b')
    await onDisconnect(ref(db, 'e2/doc')).update({ a: 2, b: 3 });
    await onDisconnect(ref(db, 'e2/doc/b')).cancel();

    // E2N: update({a:{x:2, y:3}, b:4}) + cancel('doc/a/y')
    await onDisconnect(ref(db, 'e2n/doc')).update({ a: { x: 2, y: 3 }, b: 4 });
    await onDisconnect(ref(db, 'e2n/doc/a/y')).cancel();

    // Deep nested cancel inside a queued set
    await onDisconnect(ref(db, 'setNested/doc')).set({ a: { x: 2, y: 3 }, b: 4 });
    await onDisconnect(ref(db, 'setNested/doc/a/y')).cancel();

    // C3: update({a:2, b:3}) + cancel('doc/neverQueued')
    await onDisconnect(ref(db, 'c3/doc')).update({ a: 2, b: 3 });
    await onDisconnect(ref(db, 'c3/doc/neverQueued')).cancel();

    goOffline(db);

    expect((await get(ref(admin, 'e2/doc'))).exportVal()).toEqual({
      a: 2,
      b: 1,
      keep: 'x',
    });
    expect((await get(ref(admin, 'e2n/doc'))).exportVal()).toEqual({
      a: { keep: 'x', x: 2, y: 1 },
      b: 4,
    });
    expect((await get(ref(admin, 'setNested/doc'))).exportVal()).toEqual({
      a: { keep: 'x', x: 2, y: 1 },
      b: 4,
      topKeep: 'z',
    });
    expect((await get(ref(admin, 'c3/doc'))).exportVal()).toEqual({
      a: 2,
      b: 3,
      keep: 'x',
    });
  });
});

describe('onDisconnect app ownership', () => {
  beforeEach(() => resetAppRegistryForTests());
  afterEach(() => resetAppRegistryForTests());

  it('rtdb-modular#M82 keeps pending queues client-owned and ephemeral', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'first' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'second' }));
    rtdbSandbox.setDefaultPolicy(first, 'allow');
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
    const writerDb = getDatabase(app);
    rtdbSandbox.setDefaultPolicy(writerDb, 'allow');
    const appTarget = ref(writerDb, 'presence/app');
    await set(appTarget, 'online');
    await onDisconnect(appTarget).set('offline');
    await deleteApp(app);
    const observerApp = initializeApp({ projectId: 'm82-app' }, 'm82-observer');
    const obsDb = getDatabase(observerApp);
    rtdbSandbox.setDefaultPolicy(obsDb, 'allow');
    expect((await get(ref(obsDb, 'presence/app'))).val()).toBe('offline');
  });

  it('app deletion drains that app client queue', async () => {
    const app = initializeApp({ projectId: 'disconnect-app' }, 'disconnect-app');
    const db = getDatabase(app);
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    const target = ref(db, 'presence/app');
    await set(target, 'online');
    await onDisconnect(target).set('offline');

    await deleteApp(app);
    const observerApp = initializeApp({ projectId: 'disconnect-app' }, 'observer');
    const obsDb = getDatabase(observerApp);
    rtdbSandbox.setDefaultPolicy(obsDb, 'allow');
    expect((await get(ref(obsDb, 'presence/app'))).val()).toBe('offline');
  });
});
