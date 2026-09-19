import assert from 'node:assert/strict';
import { runtimeRealm } from '../worker-runtime-realm.ts';

const serviceWorker = process.argv[2] !== undefined;
const hosted = process.argv[2] === 'hosted';
const realm = await runtimeRealm({ sharedWorker: !serviceWorker, serviceWorker, pageSdk: true });
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    realm.evaluation,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('SDK evaluation waited for init.json')), 500); }),
  ]);
  const { app, firestore, auth, database } = realm.sdk;
  const instance = app.initializeApp({ projectId: 'page-load-order' });
  auth.getAuth(instance);
  const rtdb = database.getDatabase(instance);
  database.ref(rtdb, 'presence');
  const connectionStates: boolean[] = [];
  const stopConnection = serviceWorker
    ? database.onValue(database.ref(rtdb, '.info/connected'), snapshot => connectionStates.push(snapshot.val()))
    : () => {};
  const db = firestore.getFirestore(instance);
  const read = firestore.getDoc(firestore.doc(db, 'notes/example'));
  if (serviceWorker) {
    assert.equal(realm.runtime.useWorker, true, 'SDK backend must bind before init resolves');
    assert.deepEqual(realm.connections, [], 'transport must wait for init.json');
    realm.respond({ hosted, bridgeUrl: '/__pyric/sandbox', projectKey: 'orbit' });
  }
  const snapshot = await read;
  if (serviceWorker) {
    assert.deepEqual(connectionStates, [false, true]);
    assert.deepEqual(realm.connections, [hosted ? 'wss://app.example/__pyric/sandbox' : 'service-worker-relay']);
    const subsequent = await firestore.getDoc(firestore.doc(db, 'notes/subsequent'));
    assert.equal(subsequent.exists(), false);
    assert.ok(realm.messages.some(message => message.t === 'op' && message.method === 'getDoc' && message.path === 'notes/subsequent'));
  }
  assert.equal(snapshot.exists(), false);
  assert.ok(realm.messages.some(message => message.t === 'op' && message.method === 'getDoc' && message.path === 'notes/example'));
  assert.ok(realm.messages.some(message => message.t === 'sub' && message.target === 'authState'));
  assert.equal(realm.status().mode, hosted ? 'hosted' : 'shared-worker');
  stopConnection();
  await app.deleteApp(instance);
} finally {
  clearTimeout(deadline);
  realm.respond({ hosted: false });
  await realm.evaluation.catch(() => {});
  realm.dispose();
}
