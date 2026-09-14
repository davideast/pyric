import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import * as firestore from 'pyric/firestore';
import * as database from 'pyric/database';
import { sdkActivity } from '../../src/sandbox/internal/sdk-activity.js';
import type { UsageEvidence } from '../../src/sandbox/internal/usage-evidence.js';

test('real adapters report query changes, batch document counts and RTDB payloads', async () => {
  const sandbox = initializeSandbox();
  setRules(sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }');
  sandbox.admin.setDocument('notes/one', { version: 1 });
  sandbox.admin.setDocument('notes/two', { version: 1 });
  const db = firestore.getFirestore(sandbox);
  const events: { method: string; usage: UsageEvidence }[] = [];
  const stop = sdkActivity.observe(event => { if (event.usage) events.push({ method: event.method, usage: event.usage }); });
  const unsubscribes: (() => void)[] = [];
  try {
    await new Promise<void>(resolve => {
      unsubscribes.push(firestore.onSnapshot(firestore.collection(db, 'notes'), () => resolve()));
    });
    await firestore.updateDoc(firestore.doc(db, 'notes/one'), { version: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events.filter(event => event.method === 'onSnapshot').map(event => event.usage.documentReads)).toEqual([2, 1]);
    const batch = firestore.writeBatch(db);
    batch.set(firestore.doc(db, 'notes/three'), {});
    batch.set(firestore.doc(db, 'notes/four'), {});
    batch.delete(firestore.doc(db, 'notes/two'));
    await batch.commit();
    expect(events.find(event => event.method === 'writeBatch.commit')?.usage).toEqual({ documentWrites: 2, documentDeletes: 1 });
    const rtdb = database.getDatabase(sandbox);
    database.sandbox.setDefaultPolicy(rtdb, 'allow');
    await database.set(database.ref(rtdb, 'presence'), { online: true });
    unsubscribes.push(database.onValue(database.ref(rtdb, 'presence'), () => {}));
    expect(events.find(event => event.method === 'onValue')?.usage).toEqual({ payloadBytes: 15 });
  } finally { unsubscribes.forEach(unsubscribe => unsubscribe()); stop(); }
});
