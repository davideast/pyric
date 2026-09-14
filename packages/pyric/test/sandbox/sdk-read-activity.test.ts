import { expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getFirestore, doc, collection, query, limit, getDoc, getDocs, where, orderBy, onSnapshot } from '../../src/firestore/index.js';
import { getDatabase, ref, get, set, sandbox as databaseSandbox } from '../../src/database/index.js';
import { sdkActivity, type SdkActivityEvent } from '../../src/sandbox/internal/sdk-activity.js';

it('records real Firestore reads, distinct query shapes, and denied outcomes without payloads', async () => {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox);
  setRules(sandbox, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /messages/{id} { allow read: if true; } } }");
  seedDocuments(sandbox, { 'messages/one': { text: 'hello' }, 'messages/two': { text: 'world' } });
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    const snap = await getDoc(doc(db, 'messages/one'));
    expect(snap.data()).toEqual({ text: 'hello' });
    await getDoc(doc(db, 'messages/one'));
    expect((await getDocs(collection(db, 'messages'))).size).toBe(2);
    expect((await getDocs(query(collection(db, 'messages'), limit(1)))).size).toBe(1);
    await expect(getDoc(doc(db, 'private/one'))).rejects.toBeDefined();
    const starts = events.filter(event => event.phase === 'start').map(event => event.record);
    expect(starts).toHaveLength(5);
    expect(starts[0].sourceId).toBe(starts[1].sourceId);
    expect(starts[2].target).toBe('messages');
    expect(starts[2].isQuery).toBe(true);
    expect(starts[2].sourceId).not.toBe(starts[3].sourceId);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(4);
    expect(events.filter(event => event.phase === 'end').map(event => event.record.status)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'failed',
    ]);
    expect(JSON.stringify(events)).not.toContain('hello');
  } finally { stop(); }
});

it('records real RTDB equal-value reads and denies reads without successful delivery', async () => {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  databaseSandbox.setDefaultPolicy(db, 'allow');
  const target = ref(db, 'messages');
  await set(target, { one: 'hello' });
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  try {
    expect((await get(target)).val()).toEqual({ one: 'hello' });
    await get(target);
    databaseSandbox.setDefaultPolicy(db, 'deny');
    await expect(get(target)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(events.filter(event => event.phase === 'start')).toHaveLength(3);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(2);
    expect(events.filter(event => event.phase === 'end').map(event => event.record.status)).toEqual([
      'completed', 'completed', 'failed',
    ]);
  } finally { stop(); }
});

it('keeps read settlement ordering and rejection handling when diagnostics are enabled', async () => {
  const sandbox = initializeSandbox();
  const firestore = getFirestore(sandbox);
  const database = getDatabase(sandbox);
  setRules(sandbox, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /messages/{id} { allow read: if true; } } }");
  databaseSandbox.setDefaultPolicy(database, 'allow');
  const operations = [
    () => getDoc(doc(firestore, 'messages/one')),
    () => getDocs(collection(firestore, 'messages')),
    () => get(ref(database, 'messages')),
    () => getDoc(doc(firestore, 'private/one')),
  ];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const stop = sdkActivity.subscribe(() => { throw new Error('diagnostic subscriber'); });
  async function settlement(operation: () => Promise<unknown>, silenced: boolean) {
    let ticks = 0;
    let done = false;
    const promise = silenced ? sdkActivity.silence(operation) : operation();
    const outcome = promise.then(() => 'resolved', () => 'rejected').finally(() => { done = true; });
    while (!done) { ++ticks; await Promise.resolve(); }
    return { ticks, outcome: await outcome };
  }
  try {
    for (const operation of operations) {
      expect(await settlement(operation, false)).toEqual(await settlement(operation, true));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  } finally {
    stop();
    process.off('unhandledRejection', onUnhandled);
  }
});


it('retains index query shape through listener registration, delivery and stop', async () => {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox);
  setRules(sandbox, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /projects/{id} { allow read: if true; } } }");
  seedDocuments(sandbox, { 'projects/one': { status: 'private-draft-value', budget: 12 } });
  const events: SdkActivityEvent[] = [];
  const stopRecording = sdkActivity.subscribe(event => events.push(event));
  let stopListener = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      stopListener = onSnapshot(query(collection(db, 'projects'), where('status', '==', 'private-draft-value'), orderBy('budget', 'desc')), () => resolve(), reject);
    });
    stopListener();
    const subscription = events.filter(event => event.record.kind === 'subscription');
    expect(subscription.map(event => event.phase)).toEqual(['start', 'delivery', 'end']);
    for (const event of subscription) expect(event.record.indexQuery).toEqual({ collectionGroup: 'projects', queryScope: 'COLLECTION', filters: [{ field: 'status', op: '==' }], orders: [{ field: 'budget', direction: 'desc' }] });
    expect(JSON.stringify(subscription.map(event => event.record.indexQuery))).not.toContain('private-draft-value');
  } finally { stopListener(); stopRecording(); }
});
