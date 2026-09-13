import { expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { sdkActivity, type SdkActivityEvent } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/client.js';
import { rtdbGetDatabase, rtdbRef } from '../../../src/serve/worker/client/rtdb-references.js';
import { rtdbGet } from '../../../src/serve/worker/client/rtdb-reads.js';
import { rtdbOnValue } from '../../../src/serve/worker/client/rtdb-listeners.js';
import { makeHostCtx, connectClientToHost, sleep } from './integration-support.js';

it('counts public worker reads and callbacks once while isolating independent app ports', async () => {
  const previous = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read: if true; } } }');
  const first = connectClientToHost(ctx, 'worker://activity-first').db;
  const second = connectClientToHost(ctx, 'worker://activity-second').db;
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  const unsubscribes: Array<() => void> = [];
  try {
    for (const db of [first, second]) {
      await client.getDoc(client.doc(db, 'notes/one'));
      await rtdbGet(rtdbRef(rtdbGetDatabase(db), 'notes'));
    }
    await client.getDoc(client.doc(first, 'notes/one'));
    const reads = events.filter(event => event.phase === 'start').map(event => event.record);
    expect(reads).toHaveLength(5);
    expect(reads[0].appId).toBe(reads[1].appId);
    expect(reads[2].appId).toBe(reads[3].appId);
    expect(reads[0].appId).not.toBe(reads[2].appId);
    expect(reads[0].sourceId).toBe(reads[4].sourceId);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(5);
    let callbacks = 0;
    const target = client.doc(first, 'notes/one');
    unsubscribes.push(client.onSnapshot(target, () => { ++callbacks; }));
    unsubscribes.push(client.onSnapshot(target, () => { ++callbacks; }));
    unsubscribes.push(rtdbOnValue(rtdbRef(rtdbGetDatabase(first), 'notes'), () => { ++callbacks; }));
    await sleep();
    const registrations = events.filter(event => event.phase === 'start' && event.record.kind === 'subscription').map(event => event.record);
    expect(registrations).toHaveLength(3);
    expect(callbacks).toBe(3);
    expect(events.filter(event => event.phase === 'delivery' && event.record.kind === 'subscription')).toHaveLength(callbacks);
    for (const registration of registrations) {
      const delivery = events.find(event => event.phase === 'delivery' && event.record.id === registration.id)!;
      expect(delivery.record.appId).toBe(reads[0].appId);
      expect(delivery.record.transportId).toBeDefined();
      expect(delivery.record.transportId).not.toBe(delivery.record.id);
    }
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    expect(events.filter(event => event.phase === 'end' && event.record.kind === 'subscription').map(event => event.record.status)).toEqual(['closed', 'closed', 'closed']);
    await expect(client.getDoc(client.doc(first, 'private/one'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(events.filter(event => event.phase === 'start')).toHaveLength(9);
    expect(events.at(-1)?.record).toMatchObject({ status: 'failed', deliveryCount: 0 });
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    stop();
    globalThis.SharedWorker = previous;
  }
});
