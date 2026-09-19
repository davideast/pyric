import assert from 'node:assert/strict';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createSandboxRoot, installHostedHistory } from 'pyric/sandbox/internal';
import { getFirestore, doc, setDoc, getDoc, updateDoc, increment } from 'pyric/firestore';
const directory = process.argv[2];
let persistence = await createHostedPersistence(directory);
let sandbox = createSandboxRoot();
await sandbox.enablePersistence({ key: 'hosted', injectedBackend: persistence.backend });
let engine = installHostedHistory(sandbox, persistence.history.engine);
try {
  const db = getFirestore(sandbox);
  await setDoc(doc(db, 'counter/one'), { value: 1 });
  await sandbox.flush();
  await updateDoc(doc(db, 'counter/one'), { value: increment(2) });
  await sandbox.flush();
  assert.equal(persistence.history.engine.status().undoCount, 2);
  assert.ok(engine.getEvents().some(event => event.method === 'set'));
  assert.ok(engine.getEvents().some(event => event.method === 'update'));
}
finally {
  sandbox.dispose();
  persistence.close();
}
persistence = await createHostedPersistence(directory);
sandbox = createSandboxRoot();
await sandbox.enablePersistence({ key: 'hosted', injectedBackend: persistence.backend });
engine = installHostedHistory(sandbox, persistence.history.engine);
try {
  const db = getFirestore(sandbox);
  assert.ok(engine.getEvents().some(event => event.method === 'set'));
  assert.equal((await getDoc(doc(db, 'counter/one'))).data()?.value, 3);
  engine.undo();
  await sandbox.flush();
  assert.equal((await getDoc(doc(db, 'counter/one'))).data()?.value, 1);
  engine.redo();
  await sandbox.flush();
  assert.equal((await getDoc(doc(db, 'counter/one'))).data()?.value, 3);
}
finally {
  sandbox.dispose();
  persistence.close();
}
console.log('Durable undo passed');
