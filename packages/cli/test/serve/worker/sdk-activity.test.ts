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
    expect(events.findLast(event => event.phase === 'end' && event.record.target === 'private/one')?.record).toMatchObject({ status: 'failed', deliveryCount: 0 });
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    stop();
    globalThis.SharedWorker = previous;
  }
});


it('carries index descriptors through worker query listener lifecycle without operands', async () => {
  const previous = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /projects/{id} { allow read: if true; } } }');
  const { db } = connectClientToHost(ctx, 'worker://index-query');
  const events: SdkActivityEvent[] = [];
  const stopRecording = sdkActivity.subscribe(event => events.push(event));
  let stopListener = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      stopListener = client.onSnapshot(client.query(client.collection(db, 'projects'), client.where('status', '==', 'private-draft-value'), client.orderBy('budget', 'desc')), () => resolve(), reject);
    });
    stopListener();
    const subscription = events.filter(event => event.record.kind === 'subscription');
    expect(subscription.map(event => event.phase)).toEqual(['start', 'transport', 'delivery', 'end']);
    for (const event of subscription) expect(event.record.indexQuery).toEqual({ collectionGroup: 'projects', queryScope: 'COLLECTION', filters: [{ field: 'status', op: '==' }], orders: [{ field: 'budget', direction: 'desc' }] });
    expect(JSON.stringify(subscription.map(event => event.record.indexQuery))).not.toContain('private-draft-value');
  } finally { stopListener(); stopRecording(); globalThis.SharedWorker = previous; }
});

it('carries document usage across the worker bridge without recounting unchanged query documents', async () => {
  const previous = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }');
  ctx.sandbox.admin.setDocument('notes/one', { version: 1 });
  ctx.sandbox.admin.setDocument('notes/two', { version: 1 });
  const { db } = connectClientToHost(ctx, 'worker://usage');
  const usage: number[] = [];
  const bytes: number[] = [];
  const stop = sdkActivity.observe(event => {
    if (event.method === 'onSnapshot' && event.phase === 'delivery') usage.push(event.usage?.documentReads ?? -1);
    if (event.service === 'rtdb' && event.phase === 'delivery') bytes.push(event.usage?.payloadBytes ?? -1);
  });
  let unsubscribe = () => {};
  try {
    unsubscribe = client.onSnapshot(client.collection(db, 'notes'), () => {});
    await sleep();
    await client.updateDoc(client.doc(db, 'notes/one'), { version: 2 });
    await sleep();
    expect(usage).toEqual([2, 1]);
    await rtdbGet(rtdbRef(rtdbGetDatabase(db), 'missing'));
    expect(bytes).toEqual([4]);
  } finally { unsubscribe(); stop(); globalThis.SharedWorker = previous; }
});
