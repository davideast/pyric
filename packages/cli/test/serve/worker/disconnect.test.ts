import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { disconnectClient } from '../../../src/serve/worker/client/disconnect.js';
import {
  _eventSubs,
  _snapSubs,
  disconnectPort,
  rawRpc,
  wirePort,
} from '../../../src/serve/worker/client/core.js';
import { getWorkerVersion } from '../../../src/serve/worker/client/connection.js';
import { doc } from '../../../src/serve/worker/client/firestore-refs.js';
import { onSnapshot } from '../../../src/serve/worker/client/firestore-reads.js';
import { getAuth, onAuthStateChanged } from '../../../src/serve/worker/client/auth.js';
import { rtdbGetDatabase, rtdbRef } from '../../../src/serve/worker/client/rtdb-references.js';
import { rtdbOnValue } from '../../../src/serve/worker/client/rtdb-listeners.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';

describe('explicit SharedWorker app-port disconnect', () => {
  it('runs host cleanup without relying on a MessagePort close event', async () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'disconnect-test',
      subs: new Map(),
    };
    const sent: unknown[] = [];
    const port: PortLike = { postMessage(message) { sent.push(message); } };
    let stopped = 0;
    ctx.subs.set(port, new Map([['listener', () => { stopped += 1; }]]));

    await handleMessage(ctx, port, { t: 'disconnect', id: 'disconnect-test' });

    expect(stopped).toBe(1);
    expect(ctx.subs.has(port)).toBe(false);

    await handleMessage(ctx, port, { t: 'op', id: 'after-disconnect', method: 'getVersion' });
    expect(sent.at(-1)).toMatchObject({
      t: 'res',
      id: 'after-disconnect',
      ok: false,
      error: { code: 'app/app-deleted' },
    });
  });

  it('attempts every host cleanup and acknowledges a teardown failure', async () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'disconnect-failure-test',
      subs: new Map(),
    };
    const sent: unknown[] = [];
    const port: PortLike = { postMessage(message) { sent.push(message); } };
    let laterCleanupRan = false;
    ctx.subs.set(port, new Map([
      ['throws', () => { throw new Error('listener cleanup failed'); }],
      ['later', () => { laterCleanupRan = true; }],
    ]));

    await expect(
      handleMessage(ctx, port, { t: 'disconnect', id: 'disconnect-failure' }),
    ).resolves.toBeUndefined();

    expect(laterCleanupRan).toBe(true);
    expect(ctx.subs.has(port)).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      t: 'res',
      id: 'disconnect-failure',
      ok: false,
      error: { message: expect.stringContaining('listener cleanup failed') },
    });
  });

  it('acknowledges and cleans a port previously rejected for conflicting app config', async () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'disconnect-rejected-config',
      subs: new Map(),
    };
    const acceptedPort: PortLike = { postMessage() {} };
    const sent: unknown[] = [];
    const rejectedPort: PortLike = { postMessage(message) { sent.push(message); } };
    let stopped = 0;

    await handleMessage(ctx, acceptedPort, {
      t: 'appConfig',
      options: { projectId: 'accepted' },
    });
    await handleMessage(ctx, rejectedPort, {
      t: 'appConfig',
      options: { projectId: 'conflict' },
    });
    ctx.subs.set(rejectedPort, new Map([
      ['listener', () => { stopped += 1; }],
    ]));

    await handleMessage(ctx, rejectedPort, {
      t: 'disconnect',
      id: 'disconnect-rejected-config',
    });

    expect(stopped).toBe(1);
    expect(ctx.subs.has(rejectedPort)).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      t: 'res',
      id: 'disconnect-rejected-config',
      ok: true,
    });
  });

  it('drops only the closing port client correlations and closes it', async () => {
    const sent: unknown[] = [];
    let closed = false;
    let port: MessagePort;
    port = {
      onmessage: null,
      postMessage(message: unknown) {
        sent.push(message);
        const frame = message as { t?: string; id?: string };
        if (frame.t === 'disconnect') {
          queueMicrotask(() => port.onmessage?.({
            data: { t: 'res', id: frame.id, ok: true, value: undefined },
          } as MessageEvent));
        }
      },
      close() { closed = true; },
    } as unknown as MessagePort;
    const otherPort = {
      onmessage: null,
      postMessage() {},
      close() {},
    } as unknown as MessagePort;
    const db: ClientDb = { __kind: 'client-db', port };
    wirePort(port);
    const pending = rawRpc(port, { t: 'op', id: 'disconnect-pending', method: 'getVersion' });
    _snapSubs.set('disconnect-snap', { port, next() {} });
    _snapSubs.set('other-snap', { port: otherPort, next() {} });
    _eventSubs.set('disconnect-event', { port, next() {} });

    await disconnectClient(db);

    await expect(pending).rejects.toMatchObject({ code: 'app/app-deleted' });
    expect(sent.at(-1)).toMatchObject({ t: 'disconnect' });
    expect(closed).toBe(true);
    expect(_snapSubs.has('disconnect-snap')).toBe(false);
    expect(_snapSubs.has('other-snap')).toBe(true);
    expect(_eventSubs.has('disconnect-event')).toBe(false);
    _snapSubs.delete('other-snap');
  });

  it('aborts Firestore listeners but silently stops RTDB listeners on app-port disconnect', () => {
    const port = {
      onmessage: null,
      postMessage() {},
      close() {},
    } as unknown as MessagePort;
    const db: ClientDb = { __kind: 'client-db', port };
    const firestoreErrors: Array<{ code?: string }> = [];
    const rtdbErrors: unknown[] = [];

    onSnapshot(doc(db, 'notes/deleted-app'), () => {}, (error) => {
      firestoreErrors.push(error as { code?: string });
    });
    rtdbOnValue(rtdbRef(rtdbGetDatabase(db), 'notes/deleted-app'), () => {}, (error) => {
      rtdbErrors.push(error);
    });

    disconnectPort(port);

    expect(firestoreErrors).toHaveLength(1);
    expect(firestoreErrors[0]).toMatchObject({ code: 'aborted' });
    expect(rtdbErrors).toEqual([]);
  });

  it('resolves only after host cleanup and rejects operations started afterward', async () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'disconnect-roundtrip',
      subs: new Map(),
      portSessions: new Map(),
    };
    const channel = new MessageChannel();
    const clientPort = channel.port1;
    const hostPort = channel.port2;
    wirePort(clientPort);
    hostPort.onmessage = async (event: MessageEvent) => {
      await handleMessage(ctx, hostPort as unknown as PortLike, event.data);
    };
    clientPort.start();
    hostPort.start();
    let stopped = 0;
    ctx.subs.set(hostPort as unknown as PortLike, new Map([
      ['listener', () => { stopped += 1; }],
    ]));
    ctx.portSessions.set(hostPort as unknown as PortLike, null);
    const db: ClientDb = { __kind: 'client-db', port: clientPort };

    await disconnectClient(db);

    expect(stopped).toBe(1);
    expect(ctx.subs.has(hostPort as unknown as PortLike)).toBe(false);
    expect(ctx.portSessions.has(hostPort as unknown as PortLike)).toBe(false);
    await expect(getWorkerVersion(db)).rejects.toMatchObject({ code: 'app/app-deleted' });
    hostPort.close();
  });

  it('rejects and closes when an older worker never acknowledges disconnect', async () => {
    let closed = false;
    const port = {
      onmessage: null,
      postMessage() {},
      close() { closed = true; },
    } as unknown as MessagePort;
    const db: ClientDb = { __kind: 'client-db', port };
    wirePort(port);

    await expect(disconnectClient(db, { ackTimeoutMs: 5 })).rejects.toMatchObject({
      code: 'app/delete-timeout',
    });
    expect(closed).toBe(true);
  });

  it('does not retain or post subscriptions opened after app-port disconnect', () => {
    const sent: unknown[] = [];
    const port = {
      onmessage: null,
      postMessage(message: unknown) { sent.push(message); },
      close() {},
    } as unknown as MessagePort;
    const db: ClientDb = { __kind: 'client-db', port };
    const firestoreRef = doc(db, 'notes/after-delete');
    const databaseRef = rtdbRef(rtdbGetDatabase(db), 'notes/after-delete');
    const auth = getAuth(db);
    disconnectPort(port);
    const baseline = _snapSubs.size;
    sent.length = 0;

    const unsubscribeFirestore = onSnapshot(firestoreRef, () => {});
    const unsubscribeRtdb = rtdbOnValue(databaseRef, () => {});
    const unsubscribeAuth = onAuthStateChanged(auth, () => {});
    unsubscribeFirestore();
    unsubscribeRtdb();
    unsubscribeAuth();

    expect(_snapSubs.size).toBe(baseline);
    expect(sent).toEqual([]);
  });
});
