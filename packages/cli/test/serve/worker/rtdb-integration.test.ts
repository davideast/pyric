/** Cross-boundary RTDB served-entry and app-lifecycle integration. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/index.js';
import {
  type FakePort,
  makeHostCtx,
  portPair,
  sleep,
} from './integration-support.js';

describe('RTDB served-entry integration', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

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
    const disconnectHandle = database.onDisconnect(rows);
    expect(Object.keys(disconnectHandle).sort()).toEqual(['_path', '_repo']);
    expect(disconnectHandle).toBeInstanceOf(database.OnDisconnect);
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
});
