/** RTDB client↔host and served-entry integration over fake asynchronous ports. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  cleanupPortWithDisconnect,
  handleMessage,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  endBefore as rtdbEndBefore,
  limitToFirst as rtdbLimitToFirst,
  orderByChild as rtdbOrderByChild,
  orderByPriority as rtdbOrderByPriority,
  query as buildRtdbQuery,
  startAt as rtdbStartAt,
} from 'pyric/database';
import * as client from '../../../src/serve/worker/index.js';
import { disconnectClient } from '../../../src/serve/worker/client/disconnect.js';
import {
  connectClient,
  type FakePort,
  makeHostCtx,
  portPair,
  sleep,
} from './integration-support.js';

describe('RTDB client↔host integration', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });
  afterEach(() => restoreSW());

  it('RTDB push mints a synchronous key and writes through the shared worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const root = client.rtdbRef(rtdb, 'scores');

    const pushed = client.rtdbPush(root, { value: 7 });

    expect(pushed.key).toMatch(/^[-0-9A-Z_a-z]{20}$/);
    expect(pushed.path).toBe(`/scores/${pushed.key}`);
    await pushed;

    const snap = await client.rtdbGet(pushed);
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual({ value: 7 });
  });

  it('RTDB child listeners work through the shared-worker client', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'scores');
    await client.rtdbSet(scores, { ada: { value: 7 } });

    const added: Array<{ key: string | null; value: unknown }> = [];
    const changed: Array<{ key: string | null; value: unknown }> = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(scores, (snap) => {
      added.push({ key: snap.key, value: snap.val() });
    });
    const unsubscribeChanged = client.rtdbOnChildChanged(scores, (snap) => {
      changed.push({ key: snap.key, value: snap.val() });
    });
    await sleep();

    expect(added).toEqual([{ key: 'ada', value: { value: 7 } }]);
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'grace'), { value: 9 });
    await sleep();
    expect(added.at(-1)).toEqual({ key: 'grace', value: { value: 9 } });
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 8 });
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    unsubscribeAdded();
    unsubscribeChanged();
    await client.rtdbSet(client.rtdbChild(scores, 'lin'), { value: 10 });
    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 11 });
    await sleep();
    expect(added).toHaveLength(2);
    expect(changed).toHaveLength(1);
  });

  it('RTDB child listeners preserve numeric children and ignore object field order', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'rows');
    await client.rtdbSet(rows, ['zero', 'one', 'two']);

    const added: string[] = [];
    const changed: unknown[] = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(rows, (snap) => added.push(snap.key ?? ''));
    const unsubscribeChanged = client.rtdbOnChildChanged(rows, (snap) => changed.push(snap.val()));
    await sleep();
    expect(added).toEqual(['0', '1', '2']);

    await client.rtdbSet(client.rtdbChild(rows, '1'), { a: 1, b: 2 });
    await sleep();
    expect(changed).toEqual([{ a: 1, b: 2 }]);
    await client.rtdbSet(client.rtdbChild(rows, '1'), { b: 2, a: 1 });
    await sleep();
    expect(changed).toHaveLength(1);

    unsubscribeAdded();
    unsubscribeChanged();
  });

  it('validates ref and child paths before crossing the worker boundary', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);

    expect(() => client.rtdbRef(rtdb, 'invalid.path')).toThrow('invalid path');
    expect(() => client.rtdbChild(client.rtdbRef(rtdb), '')).toThrow('invalid path');
    expect(() => client.rtdbChild(client.rtdbRef(rtdb), 'invalid#path')).toThrow('invalid path');
  });

  it('delivers the complete initial child_added batch for onlyOnce', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'only-once-rows');
    await client.rtdbSet(rows, { a: 1, b: 2 });

    const seen: string[] = [];
    client.rtdbOnChildAdded(rows, (snapshot) => seen.push(snapshot.key!), { onlyOnce: true });
    await sleep();
    await client.rtdbSet(client.rtdbChild(rows, 'c'), 3);
    await sleep();

    expect(seen).toEqual(['b', 'a']);
    expect(seen).not.toContain('c');

    const deliveredDespiteThrow: string[] = [];
    client.rtdbOnChildAdded(rows, (snapshot) => {
      deliveredDespiteThrow.push(snapshot.key!);
      throw new Error('listener failure');
    }, { onlyOnce: true });
    await sleep();
    expect(deliveredDespiteThrow).toEqual(['c', 'b', 'a']);
  });

  it('removes duplicate callbacks one registration at a time and scopes query off', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const target = client.rtdbRef(rtdb, 'off-semantics/value');
    await client.rtdbSet(target, 0);
    const values: unknown[] = [];
    const callback = (snapshot: client.RtdbDataSnapshot) => values.push(snapshot.val());
    client.rtdbOnValue(target, callback);
    client.rtdbOnValue(target, callback);
    await sleep();
    await client.rtdbSet(target, 1);
    await sleep();
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 2);
    await sleep();
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 3);
    await sleep();
    expect(values).toEqual([0, 0, 1, 1, 2]);

    const rows = client.rtdbRef(rtdb, 'off-semantics/rows');
    await client.rtdbSet(rows, { a: { rank: 1 }, b: { rank: 2 } });
    const ordered = buildRtdbQuery(rows as never, rtdbOrderByChild('rank'), rtdbLimitToFirst(2));
    const reorderedEquivalent = buildRtdbQuery(rows as never, rtdbLimitToFirst(2), rtdbOrderByChild('rank'));
    const defaultValues: unknown[] = [];
    const orderedValues: unknown[] = [];
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    client.rtdbOnValue(ordered as never, (snapshot) => orderedValues.push(snapshot.val()));
    await sleep();
    client.rtdbOff(reorderedEquivalent as never);
    await client.rtdbSet(client.rtdbChild(rows, 'c'), { rank: 3 });
    await sleep();
    expect(defaultValues).toHaveLength(2);
    expect(orderedValues).toHaveLength(1);

    const defaultQuery = buildRtdbQuery(rows as never);
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    await sleep();
    client.rtdbOff(defaultQuery as never);
    await client.rtdbSet(client.rtdbChild(rows, 'default-query-control'), true);
    await sleep();
    expect(defaultValues).toHaveLength(3);
    client.rtdbOff(rows);
    await client.rtdbSet(client.rtdbChild(rows, 'd'), { rank: 4 });
    await sleep();
    expect(defaultValues).toHaveLength(3);
  });

  it('executes RTDB queries, priority writes, transactions, and child movement through the worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'worker-api/scores');
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'ada'), { score: 7 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'grace'), { score: 9 }, 10);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'lin'), { score: 11 }, 30);

    const priorityWindow = buildRtdbQuery(
      scores as never,
      rtdbOrderByPriority(),
      rtdbLimitToFirst(2),
    );
    const initialKeys: string[] = [];
    (await client.rtdbGet(priorityWindow as never)).forEach((snap) => {
      initialKeys.push(snap.key!);
    });
    expect(initialKeys).toEqual(['grace', 'ada']);

    const valueWindows: string[][] = [];
    const moved: Array<{ key: string | null; previous: string | null }> = [];
    const removed: Array<{ key: string | null; value: unknown; previous: string | null }> = [];
    const stopValue = client.rtdbOnValue(priorityWindow as never, (snapshot) => {
      const keys: string[] = [];
      snapshot.forEach((child) => { keys.push(child.key!); });
      valueWindows.push(keys);
    });
    const priorityOrder = buildRtdbQuery(scores as never, rtdbOrderByPriority());
    const stopMoved = client.rtdbOnChildMoved(
      priorityOrder as never,
      (snapshot, previous) => moved.push({ key: snapshot.key, previous }),
    );
    const stopRemoved = client.rtdbOnChildRemoved(
      scores,
      (snapshot, previous) => removed.push({
        key: snapshot.key, value: snapshot.val(), previous,
      }),
    );
    await sleep();

    await client.rtdbSetPriority(client.rtdbChild(scores, 'ada'), 5);
    await sleep();
    expect(valueWindows.at(-1)).toEqual(['ada', 'grace']);
    expect(moved).toEqual([{ key: 'ada', previous: null }]);

    await client.rtdbSetPriority(client.rtdbChild(scores, 'lin'), 25);
    await sleep();
    expect(moved).toEqual([
      { key: 'ada', previous: null },
      { key: 'lin', previous: 'grace' },
    ]);

    const scoreWindow = buildRtdbQuery(
      scores as never,
      rtdbOrderByChild('score'),
      rtdbStartAt(8),
      rtdbEndBefore(11),
    );
    const scoreKeys: string[] = [];
    (await client.rtdbGet(scoreWindow as never)).forEach((snap) => scoreKeys.push(snap.key!));
    expect(scoreKeys).toEqual(['grace']);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await sleep();
    expect(removed).toEqual([{
      key: 'grace', value: { score: 9 }, previous: 'ada',
    }]);

    const counter = client.rtdbRef(rtdb, 'worker-api/counter');
    await client.rtdbSet(counter, 4);
    const transaction = await client.rtdbRunTransaction<number>(counter, (current) => (current ?? 0) + 1);
    expect(transaction.committed).toBe(true);
    expect(transaction.snapshot.val()).toBe(5);
    expect(transaction.toJSON()).toEqual({ committed: true, snapshot: 5 });

    stopValue();
    stopMoved();
    stopRemoved();
  });

  it('goOffline drains a writer port onDisconnect queue once while an independent port observes', async () => {
    const ctx = await makeHostCtx();
    const connectPort = (url: string) => {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
      hostPort.onmessage = (event) => { void handleMessage(ctx, hostPortLike, event.data as InboundMessage); };
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor(_url: unknown, _opts: unknown) {}
      };
      return { db: client.getFirestore(url), hostPort: hostPortLike };
    };

    const { db: writerClient, hostPort: writerHostPort } = connectPort('worker://disconnect-writer');
    const { db: observerClient } = connectPort('worker://disconnect-observer');
    const writerDb = client.rtdbGetDatabase(writerClient);
    const observerDb = client.rtdbGetDatabase(observerClient);
    const writerRef = client.rtdbRef(writerDb, 'disconnect');
    const observerRef = client.rtdbRef(observerDb, 'disconnect');
    await client.rtdbSet(writerRef, {
      presence: { state: 'online', child: 'original-child' },
      update: { keep: true, value: 1 },
      nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
      remove: { before: true },
      cancelled: { child: 'original' },
    });

    const events: unknown[] = [];
    const unsubscribe = client.rtdbOnValue(observerRef, (snapshot) => events.push(snapshot.val()));
    await sleep();
    const presence = client.rtdbChild(writerRef, 'presence');
    await client.rtdbOnDisconnect(presence).set({ state: 'offline', child: 'parent-child' });
    await client.rtdbOnDisconnect(client.rtdbChild(presence, 'child')).set('queued-child');
    await client.rtdbOnDisconnect(client.rtdbChild(presence, 'child')).cancel();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'update')).update({ value: 2, added: true });
    const nestedUpdate = client.rtdbChild(writerRef, 'nestedUpdate');
    await client.rtdbOnDisconnect(nestedUpdate).update({ a: { b: 'new' }, changed: true });
    await client.rtdbOnDisconnect(client.rtdbChild(nestedUpdate, 'a/b')).set('child-write');
    await client.rtdbOnDisconnect(client.rtdbChild(nestedUpdate, 'a/b')).cancel();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'remove')).remove();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'cancelled/child')).set('queued-child');
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'cancelled')).cancel();
    expect((await client.rtdbGet(client.rtdbChild(observerRef, 'presence'))).val())
      .toEqual({ state: 'online', child: 'original-child' });

    client.rtdbGoOffline(writerDb);
    await sleep();
    const terminal = (await client.rtdbGet(observerRef)).val();
    expect(terminal).toEqual({
      presence: { state: 'offline', child: 'original-child' },
      update: { keep: true, value: 2, added: true },
      nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true, changed: true },
      cancelled: { child: 'original' },
    });
    expect(events).toEqual([
      {
        presence: { state: 'online', child: 'original-child' },
        update: { keep: true, value: 1 },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 1 },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 2, added: true },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 2, added: true },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true, changed: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      terminal,
    ]);
    await cleanupPortWithDisconnect(ctx, writerHostPort);
    await sleep();
    expect(events).toHaveLength(5);
    unsubscribe();
  });

  it('served app deletion drains its worker-owned onDisconnect queue', async () => {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const { workerClientForApp } = await import('../../../src/serve/entries/app-client.js');
    const options = getApps()[0]?.options ?? { projectId: 'served-delete' };
    const writerApp = initializeApp(options, 'served-delete-writer');
    const observerApp = initializeApp(options, 'served-delete-observer');
    const writerDb = client.rtdbGetDatabase(workerClientForApp(writerApp));
    const observerDb = client.rtdbGetDatabase(workerClientForApp(observerApp));
    const writerRef = client.rtdbRef(writerDb, 'served/delete');
    await client.rtdbSet(writerRef, 'online');
    await client.rtdbOnDisconnect(writerRef).set('offline');

    await deleteApp(writerApp);
    await sleep();
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'served/delete'))).val()).toBe('offline');
    await deleteApp(observerApp);
  });

  it('serves the completed firebase/database surface over an app-owned worker port', async () => {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const database = await import('../../../src/serve/entries/database.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'served-database-surface' },
      `served-database-surface-${Math.random()}`,
    );
    const db = database.getDatabase(app);
    expect(db).toBeInstanceOf(database.Database);
    const rows = database.ref(db, 'served-api/rows');
    await database.setWithPriority(database.child(rows, 'second'), { rank: 2 }, 20);
    await database.setWithPriority(database.child(rows, 'first'), { rank: 1 }, 10);

    expect((await database.get(rows)).exportVal()).toEqual({
      first: { rank: 1, '.priority': 10 },
      second: { rank: 2, '.priority': 20 },
    });
    expect((await database.get(rows)).toJSON()).toEqual({
      first: { rank: 1, '.priority': 10 },
      second: { rank: 2, '.priority': 20 },
    });

    const priorityConstraint = database.orderByPriority();
    expect(priorityConstraint).toBeInstanceOf(database.QueryConstraint);
    const ordered = database.query(rows, priorityConstraint, database.limitToFirst(1));
    const keys: string[] = [];
    const orderedSnapshot = await database.get(ordered);
    expect(orderedSnapshot).toBeInstanceOf(database.DataSnapshot);
    orderedSnapshot.forEach((snapshot) => { keys.push(snapshot.key!); });
    expect(keys).toEqual(['first']);

    const counter = database.ref(db, 'served-api/counter');
    await database.set(counter, 1);
    await database.set(counter, database.increment(2));
    expect((await database.get(counter)).val()).toBe(3);
    const result = await database.runTransaction(counter, (current) => (current ?? 0) + 1);
    expect(result).toBeInstanceOf(database.TransactionResult);
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(4);

    const offTarget = database.ref(db, 'served-api/off');
    const calls: string[] = [];
    const kept = () => calls.push('kept');
    const removedCallback = () => calls.push('removed');
    database.onValue(offTarget, kept);
    database.onValue(offTarget, removedCallback);
    await sleep();
    calls.length = 0;
    database.off(offTarget, 'value', removedCallback);
    await database.set(offTarget, true);
    await sleep();
    expect(calls).toEqual(['kept']);
    database.off(offTarget);

    const removed: string[] = [];
    const unsubscribe = database.onChildRemoved(rows, (snapshot) => removed.push(snapshot.key!));
    await sleep();
    await database.remove(database.child(rows, 'second'));
    await sleep();
    expect(removed).toEqual(['second']);
    unsubscribe();
    await deleteApp(app);
  });

  it('non-persisted pagehide drains the served app worker queue', async () => {
    const ctx = await makeHostCtx();
    const pagehideListeners = new Set<(event: Event) => void>();
    const priorAdd = globalThis.addEventListener;
    const priorRemove = globalThis.removeEventListener;
    globalThis.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.add(listener as (event: Event) => void);
      }
    }) as typeof globalThis.addEventListener;
    globalThis.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.delete(listener as (event: Event) => void);
      }
    }) as typeof globalThis.removeEventListener;
    try {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port: FakePort;
        constructor(_url: unknown, _opts: unknown) {
          const { a: clientPort, b: hostPort } = portPair();
          const hostPortLike: PortLike = {
            postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
          };
          hostPort.onmessage = (event) => {
            void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
          };
          this.port = clientPort;
        }
      };
      const { workerClientForApp } = await import('../../../src/serve/entries/app-client.js');
      const options = getApps()[0]?.options ?? { projectId: 'served-delete' };
      const writerApp = initializeApp(options, 'served-pagehide-writer');
      const writerDb = client.rtdbGetDatabase(workerClientForApp(writerApp));
      const writerRef = client.rtdbRef(writerDb, 'served/pagehide');
      await client.rtdbSet(writerRef, 'online');
      await client.rtdbOnDisconnect(writerRef).set('offline');

      for (const listener of pagehideListeners) {
        listener({ persisted: false } as PageTransitionEvent);
      }
      await sleep();
      const observerApp = initializeApp(options, 'served-pagehide-observer');
      const observerDb = client.rtdbGetDatabase(workerClientForApp(observerApp));
      expect((await client.rtdbGet(client.rtdbRef(observerDb, 'served/pagehide'))).val()).toBe('offline');
      await deleteApp(writerApp);
      await deleteApp(observerApp);
    } finally {
      globalThis.addEventListener = priorAdd;
      globalThis.removeEventListener = priorRemove;
    }
  });

  it('continues worker disconnect draining after a rules denial and still tears down the writer', async () => {
    const ctx = await makeHostCtx();
    const connectPort = (url: string) => {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
      hostPort.onmessage = (event) => { void handleMessage(ctx, hostPortLike, event.data as InboundMessage); };
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor(_url: unknown, _opts: unknown) {}
      };
      return client.getFirestore(url);
    };

    const writerClient = connectPort('worker://disconnect-rules-writer');
    const observerClient = connectPort('worker://disconnect-rules-observer');
    const writerDb = client.rtdbGetDatabase(writerClient);
    const observerDb = client.rtdbGetDatabase(observerClient);
    const target = client.rtdbRef(writerDb, 'rulesTarget');
    const control = client.rtdbRef(writerDb, 'drainControl');
    await client.setDatabaseRules(writerClient, { rules: {
      rulesTarget: { '.read': true, '.write': true },
      drainControl: { '.read': true, '.write': true },
    } });
    await client.rtdbSet(target, 'seed');
    await client.rtdbOnDisconnect(target).set('denied');
    await client.rtdbOnDisconnect(control).set('drained');
    await client.setDatabaseRules(writerClient, { rules: {
      rulesTarget: { '.read': true, '.write': false },
      drainControl: { '.read': true, '.write': true },
    } });

    await expect(disconnectClient(writerClient)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'rulesTarget'))).val()).toBe('seed');
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'drainControl'))).val()).toBe('drained');
  });
});
