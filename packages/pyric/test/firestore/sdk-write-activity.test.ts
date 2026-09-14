import { readDocumentAs, readQueryAs } from '../../src/firestore/reads.js';
import { expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore, doc, collection, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, runTransaction,
  getDocFromServer, getDocsFromServer, getDocFromCache, getDocsFromCache, getCountFromServer, getAggregateFromServer, count } from '../../src/firestore/index.js';
import { sdkActivity, type SdkActivityEvent } from '../../src/sandbox/internal/sdk-activity.js';

it('counts public writes, batch commits and transaction attempts without write deliveries or nested calls', async () => {
  const sandbox = initializeSandbox();
  setRules(sandbox, `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }`);
  const db = getFirestore(sandbox);
  const target = doc(db, 'notes/one');
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    await setDoc(target, { version: 1 });
    await updateDoc(target, { version: 2 });
    await deleteDoc(target);
    await addDoc(collection(db, 'notes'), { version: 3 });
    const batch = writeBatch(db);
    batch.set(target, { version: 4 });
    batch.set(doc(db, 'notes/two'), { version: 4 });
    expect(events.filter(event => event.phase === 'start')).toHaveLength(4);
    await batch.commit();
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(target);
      transaction.update(target, { version: snapshot.data()!.version + 1 });
    });
    await expect(setDoc(doc(db, 'private/one'), { secret: 'not in observations' })).rejects.toBeDefined();
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual([
      'setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'writeBatch.commit', 'runTransaction', 'setDoc',
    ]);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(0);
    expect(events.filter(event => event.phase === 'end').map(event => event.record.status)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'failed',
    ]);
    expect(JSON.stringify(events)).not.toContain('not in observations');
  } finally { stop(); }
});

it('preserves public read aliases and aggregate methods without nested getDoc/getDocs observations', async () => {
  const sandbox = initializeSandbox();
  setRules(sandbox, `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }`);
  const db = getFirestore(sandbox);
  const target = doc(db, 'notes/one');
  const source = collection(db, 'notes');
  await setDoc(target, { version: 1 });
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    await getDocFromServer(target);
    await getDocsFromServer(source);
    await getDocFromCache(target);
    await getDocsFromCache(source);
    expect((await getCountFromServer(source)).data().count).toBe(1);
    expect((await getAggregateFromServer(source, { total: count() })).data().total).toBe(1);
    await expect(getDocFromCache(doc(db, 'notes/missing'))).rejects.toBeDefined();
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual([
      'getDocFromServer', 'getDocsFromServer', 'getDocFromCache', 'getDocsFromCache', 'getCountFromServer', 'getAggregateFromServer', 'getDocFromCache',
    ]);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(6);
    expect(events.filter(event => event.phase === 'end').at(-1)?.record.status).toBe('failed');
  } finally { stop(); }
});


it('keeps served cache aliases on the authoritative backend path while naming each public call', async () => {
  const sandbox = initializeSandbox();
  setRules(sandbox, `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read: if true; } } }`);
  const db = getFirestore(sandbox);
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    // A served cache alias has historically read uncached data from the backend.
    expect((await readDocumentAs(doc(db, 'notes/missing'), 'getDocFromCache')).exists()).toBe(false);
    expect((await readQueryAs(collection(db, 'notes'), 'getDocsFromCache')).size).toBe(0);
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual(['getDocFromCache', 'getDocsFromCache']);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(2);
  } finally { stop(); }
});
