import { describe, expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { Timestamp } from 'pyric/firestore';
import * as client from '../../../src/serve/worker/index.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if true; }
    match /denied/{id} { allow read, write: if false; }
  }
}`;

describe('worker Firestore network lifecycle and serverTimestamp options', () => {
  it('holds offline writes pending with local snapshots and flushes or rejects on enableNetwork', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-net-${Math.random()}`);

    const itemRef = client.doc(db, 'items/a');
    await client.disableNetwork(db);

    let writeSettled = false;
    const write = client.setDoc(itemRef, { status: 'queued', ts: client.serverTimestamp() }).then(() => {
      writeSettled = true;
    });
    let waitSettled = false;
    const waiting = client.waitForPendingWrites(db).then(() => {
      waitSettled = true;
    });

    await sleep(20);
    expect(writeSettled).toBe(false);
    expect(waitSettled).toBe(false);

    const offlineSnap = await client.getDoc(itemRef);
    expect(offlineSnap.exists()).toBe(true);
    expect(offlineSnap.metadata.fromCache).toBe(true);
    expect(offlineSnap.metadata.hasPendingWrites).toBe(true);
    expect(offlineSnap.data()).toEqual({ status: 'queued', ts: null });
    expect((offlineSnap.data({ serverTimestamps: 'estimate' }) as { ts?: unknown })?.ts).toBeInstanceOf(Timestamp);

    await client.enableNetwork(db);
    await Promise.all([write, waiting]);
    expect(writeSettled).toBe(true);
    expect(waitSettled).toBe(true);

    const onlineSnap = await client.getDoc(itemRef);
    expect(onlineSnap.metadata.fromCache).toBe(false);
    expect(onlineSnap.metadata.hasPendingWrites).toBe(false);
    expect((onlineSnap.data() as { ts?: unknown })?.ts).toBeInstanceOf(Timestamp);

    host.sandbox.dispose();
  });
});
