import { readDocumentAs, readQueryAs } from '../../../src/serve/worker/client/firestore-reads.js';
import { getDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { sdkActivity, type SdkActivityEvent } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/client.js';
import { rtdbGetDatabase, rtdbRef } from '../../../src/serve/worker/client/rtdb-references.js';
import { rtdbSet, rtdbUpdate, rtdbRemove, rtdbPush, rtdbSetPriority, rtdbSetWithPriority } from '../../../src/serve/worker/client/rtdb-writes.js';
import { rtdbRunTransaction } from '../../../src/serve/worker/client/rtdb-transactions.js';
import { makeHostCtx, connectClientToHost } from './integration-support.js';

it('counts worker Firestore public calls once across host mirrors, batch writes, aggregate reads and retry attempts', async () => {
  const previous = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }`);
  const { db } = connectClientToHost(ctx, 'worker://write-activity');
  const target = client.doc(db, 'notes/one');
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    await client.setDoc(target, { version: 1 });
    await client.updateDoc(target, { version: 2 });
    await client.addDoc(client.collection(db, 'notes'), { version: 3 });
    const batch = client.writeBatch(db);
    batch.set(target, { version: 4 });
    batch.set(client.doc(db, 'notes/two'), { version: 4 });
    await batch.commit();
    let attempts = 0;
    await client.runTransaction(db, async transaction => {
      const snap = await transaction.get(target);
      if (++attempts === 1) await client.updateDoc(target, { version: 10 });
      transaction.update(target, { version: Number(snap.data()!.version) + 1 });
    });
    expect(attempts).toBe(2);
    await client.getCountFromServer(client.collection(db, 'notes'));
    await client.getAggregateFromServer(client.collection(db, 'notes'), { total: client.count() });
    await readDocumentAs(target, 'getDocFromServer');
    await readDocumentAs(target, 'getDocFromCache');
    await readQueryAs(client.collection(db, 'notes'), 'getDocsFromServer');
    await readQueryAs(client.collection(db, 'notes'), 'getDocsFromCache');
    await client.deleteDoc(target);
    await expect(client.setDoc(client.doc(db, 'private/one'), {})).rejects.toMatchObject({ code: 'permission-denied' });
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual([
      'setDoc', 'updateDoc', 'addDoc', 'writeBatch.commit', 'runTransaction', 'updateDoc', 'getCountFromServer', 'getAggregateFromServer', 'getDocFromServer', 'getDocFromCache', 'getDocsFromServer', 'getDocsFromCache', 'deleteDoc', 'setDoc',
    ]);
    expect(events.filter(event => event.phase === 'delivery').map(event => event.record.method)).toEqual(['getCountFromServer', 'getAggregateFromServer', 'getDocFromServer', 'getDocFromCache', 'getDocsFromServer', 'getDocsFromCache']);
    expect(events.at(-1)?.record.status).toBe('failed');
  } finally { stop(); globalThis.SharedWorker = previous; }
});

it('counts worker RTDB public writes once, including multipath updates, pushes and transaction retries', async () => {
  const previous = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  const { db } = connectClientToHost(ctx, 'worker://rtdb-write-activity');
  const target = rtdbRef(rtdbGetDatabase(db), 'counter');
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    await rtdbSet(target, { value: 1 });
    await rtdbUpdate(target, { 'one/a': 2, 'two/b': 3 });
    await rtdbSetPriority(target, 1);
    await rtdbSetWithPriority(target, 2, 1);
    await rtdbPush(target, 3);
    await rtdbPush(target);
    await rtdbRemove(target);
    await rtdbSet(target, 1);
    let attempts = 0;
    const pendingWrites: Promise<void>[] = [];
    const result = await rtdbRunTransaction<number>(target, value => {
      if (++attempts === 1) pendingWrites.push(rtdbSet(target, 10));
      return (value ?? 0) + 1;
    });
    await Promise.all(pendingWrites);
    databaseSandbox.setDefaultPolicy(getDatabase(ctx.sandbox), 'deny');
    await expect(rtdbUpdate(target, { 'one/a': 1, 'two/b': 2 })).rejects.toBeDefined();
    expect(events.at(-1)?.record.status).toBe('failed');
    expect(result.committed).toBe(true);
    expect(attempts).toBe(2);
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual([
      'set', 'update', 'setPriority', 'setWithPriority', 'push', 'remove', 'set', 'runTransaction', 'set', 'update',
    ]);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(0);
  } finally { stop(); globalThis.SharedWorker = previous; }
});
