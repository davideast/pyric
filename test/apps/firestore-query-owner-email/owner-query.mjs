import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { collection, doc, FieldPath, getDocs, getFirestore, query, setDoc, where } from 'pyric/firestore';

const sandbox = initializeSandbox();
setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/items/{id} {
    allow create: if request.auth.uid == id;
    allow list: if request.auth != null && request.auth.token.email == resource.data.owner.email;
  }
}`);

const users = ['ada', 'bea'].map(uid => {
  const email = uid + '@example.test';
  const db = getFirestore(sandbox.withAuth({ uid, token: { email } }));
  return { uid, email, items: collection(db, 'items') };
});
for (const { uid, email, items } of users) {
  await setDoc(doc(items, uid), { owner: { email } });
}

for (const user of users) {
  const peer = users.find(other => other.uid !== user.uid);
  const filtered = email => query(user.items, where('owner.email', '==', email));
  const own = await getDocs(filtered(user.email));
  assert.deepEqual(own.docs.map(doc => doc.id), [user.uid]);
  await assert.rejects(getDocs(filtered(peer.email)), { code: 'permission-denied' });
  await assert.rejects(getDocs(user.items), { code: 'permission-denied' });
  const literalKey = new FieldPath('owner.email');
  await assert.rejects(getDocs(query(user.items, where(literalKey, '==', user.email))), { code: 'permission-denied' });
}
