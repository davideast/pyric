/**
 * `QuerySnapshot.forEach` visits each document once (#1203). The sandbox's
 * error-translation proxy ran every method inside the provenance window and
 * fell back to a second call when the window returned `undefined`, so a
 * void method such as `forEach` ran its callback twice per document.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import { collection, doc, getDocs, getFirestore, orderBy, query, setDoc } from '../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read, write: if true; }
  }
}`;

test('the modular getDocs snapshot visits each document once with forEach', async () => {
  const sandbox = initializeSandbox();
  try {
    getAdminCompatFirestore(sandbox.withAuth(null)).setRules(OPEN_RULES);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'posts/b'), { n: 2 });
    await setDoc(doc(db, 'posts/a'), { n: 1 });
    const snap = await getDocs(query(collection(db, 'posts'), orderBy('n')));
    const visited: string[] = [];
    snap.forEach((document) => { visited.push(document.id); });
    expect(visited).toEqual(['a', 'b']);
  } finally {
    getInternalEnv(sandbox).dispose();
  }
});

test('the Admin-shaped query snapshot visits each document once with forEach', async () => {
  const sandbox = initializeSandbox();
  try {
    const admin = getAdminCompatFirestore(sandbox.withAuth(null));
    admin.setRules(OPEN_RULES);
    admin.seed({ documents: { 'posts/a': { n: 1 }, 'posts/b': { n: 2 } } });
    const snap = await admin.collection('posts').orderBy('n').get();
    const visited: string[] = [];
    snap.forEach((document) => { visited.push(document.id); });
    expect(visited).toEqual(['a', 'b']);
  } finally {
    getInternalEnv(sandbox).dispose();
  }
});
