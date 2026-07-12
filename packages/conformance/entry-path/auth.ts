/**
 * Entry-path conformance program — `pyric/app` + `pyric/auth`.
 *
 * Adapted from Firebase's official web quickstart shape:
 *   - https://firebase.google.com/docs/auth/web/start
 *     (`initializeApp`, `getAuth`, `onAuthStateChanged`)
 *   - https://firebase.google.com/docs/auth/web/auth-state-persistence
 *     (`setPersistence(auth, browserSessionPersistence)`)
 *   - https://firebase.google.com/docs/auth/web/password-auth
 *     (`createUserWithEmailAndPassword`)
 *
 * The only adjustment pyric requires: `initializeApp({ sandbox:
 * initializeSandbox() })` in place of `initializeApp(firebaseConfig)`.
 * Everything downstream is the exact modular-SDK call shape the quickstarts
 * show — import subpaths, argument order, and the persistence-then-sign-in
 * sequencing the persistence doc's own example uses.
 */
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
} from 'pyric/auth';

export async function run(): Promise<void> {
  const app = initializeApp({ sandbox: initializeSandbox() });
  const auth = getAuth(app);

  // https://firebase.google.com/docs/auth/web/start — "Set an authentication
  // state observer and get user data."
  let observedUid: string | null | undefined;
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    observedUid = user ? user.uid : null;
  });

  // https://firebase.google.com/docs/auth/web/auth-state-persistence
  await setPersistence(auth, browserSessionPersistence);

  // https://firebase.google.com/docs/auth/web/password-auth — the one real
  // operation this program performs and asserts.
  const email = 'ada.lovelace@example.com';
  const password = 'entry-path-quickstart-1';
  const credential = await createUserWithEmailAndPassword(auth, email, password);

  unsubscribe();

  if (!credential.user || credential.user.email !== email) {
    throw new Error(
      `createUserWithEmailAndPassword did not return the expected user (got email=${credential.user?.email ?? 'null'})`,
    );
  }
  if (auth.currentUser?.uid !== credential.user.uid) {
    throw new Error('auth.currentUser did not sync to the newly created user');
  }
  if (observedUid !== credential.user.uid) {
    throw new Error('onAuthStateChanged observer never fired with the created user');
  }
}
