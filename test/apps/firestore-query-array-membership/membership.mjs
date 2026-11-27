import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { collection, doc, getDocs, getFirestore, query, setDoc, updateDoc, where } from 'pyric/firestore';

const sandbox = initializeSandbox();
setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/items/{id} {
    allow create: if request.auth.uid in request.resource.data.members;
    allow update, list: if request.auth.uid in resource.data.members;
  }
}`);
const itemsFor = uid => collection(getFirestore(sandbox.withAuth({ uid })), 'items');
const a = itemsFor('a');
await setDoc(doc(a, 'x'), { members: ['a', 'b'] });
await setDoc(doc(itemsFor('b'), 'y'), { members: ['b', 'c'] });

async function verify() {
  const list = members => getDocs(query(a, where('members', 'array-contains-any', members)));
  const snapshot = await list(['a']);
  assert.deepEqual(snapshot.docs.map(doc => doc.id), ['x']);
  await assert.rejects(list(['a', 'd']), { code: 'permission-denied' });
}
await verify();
await updateDoc(doc(a, 'x'), { members: ['a', 'c'] });
await verify();
