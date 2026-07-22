/** RTDB worker-client disconnect queues and explicit connection lifecycle. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanupPortWithDisconnect } from '../../../../src/serve/worker/host.js';
import * as client from '../../../../src/serve/worker/index.js';
import { disconnectClient } from '../../../../src/serve/worker/client/disconnect.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';

describe('RTDB worker connection lifecycle', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('goOffline drains a writer port onDisconnect queue once while an independent port observes', async () => {
    const ctx = await makeHostCtx();
    const { db: writerClient, hostPort: writerHostPort } = connectClientToHost(
      ctx,
      'worker://disconnect-writer',
    );
    const { db: observerClient } = connectClientToHost(ctx, 'worker://disconnect-observer');
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

  it('continues disconnect draining after a rules denial and still tears down the writer', async () => {
    const ctx = await makeHostCtx();
    const { db: writerClient } = connectClientToHost(ctx, 'worker://disconnect-rules-writer');
    const { db: observerClient } = connectClientToHost(ctx, 'worker://disconnect-rules-observer');
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
