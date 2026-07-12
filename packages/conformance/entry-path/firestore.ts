/**
 * Entry-path conformance program — `pyric/app` + `pyric/firestore`.
 *
 * Adapted from Firebase's official web quickstart:
 *   - https://firebase.google.com/docs/firestore/quickstart
 *     (`initializeApp`, `getFirestore`, `collection` + `addDoc`, the exact
 *     `{ first, last, born }` sample document)
 *
 * The only adjustment pyric requires: `initializeApp({ sandbox:
 * initializeSandbox() })` in place of `initializeApp(firebaseConfig)`.
 */
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, collection, addDoc } from 'pyric/firestore';

export async function run(): Promise<void> {
  const app = initializeApp({ sandbox: initializeSandbox() });
  const db = getFirestore(app);

  // https://firebase.google.com/docs/firestore/quickstart — the one real
  // operation this program performs and asserts.
  const docRef = await addDoc(collection(db, 'users'), {
    first: 'Ada',
    last: 'Lovelace',
    born: 1815,
  });

  if (!docRef.id || typeof docRef.id !== 'string') {
    throw new Error(`addDoc did not return a usable document id (got ${JSON.stringify(docRef.id)})`);
  }
}
