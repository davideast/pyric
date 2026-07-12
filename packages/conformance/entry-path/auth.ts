/**
 * Entry-path conformance program — `pyric/app` + `pyric/auth`.
 *
 * Adapted from Firebase's official web quickstart shape:
 *   - https://firebase.google.com/docs/auth/web/start
 *     (`initializeApp`, `getAuth`, `onAuthStateChanged`)
 *   - https://firebase.google.com/docs/auth/web/auth-state-persistence
 *     (`setPersistence` with each of the three persistence tokens)
 *   - https://firebase.google.com/docs/auth/web/password-auth
 *     (`createUserWithEmailAndPassword`)
 *
 * This program exercises BOTH auth initialization front doors, not one.
 * `getAuth` and `initializeAuth` are alternative entry points; the entry-path
 * gate proves a symbol only if a program imports and runs it, so picking one
 * would drop the other from the proven set. Both are run, and their documented
 * idempotency (one handle per app) is asserted. All three persistence tokens
 * are set for the same reason: a real app picks one, but each is a distinct
 * entry point the gate should prove resolves.
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
  initializeAuth,
  onAuthStateChanged,
  setPersistence,
  inMemoryPersistence,
  browserSessionPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
} from 'pyric/auth';

export async function run(): Promise<void> {
  const app = initializeApp({ sandbox: initializeSandbox() });

  // The explicit-init front door: `initializeAuth(app, { persistence })` is
  // the pattern app code writes when it configures auth up front.
  const auth = initializeAuth(app, { persistence: browserLocalPersistence });

  // `initializeAuth` and `getAuth` are the two front doors; both resolve to
  // the one handle per app. Asserting equality exercises both entry points
  // and pins the documented idempotency.
  if (getAuth(app) !== auth) {
    throw new Error('initializeAuth and getAuth returned different handles for one app');
  }

  // https://firebase.google.com/docs/auth/web/start — "Set an authentication
  // state observer and get user data."
  let observedUid: string | null | undefined;
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    observedUid = user ? user.uid : null;
  });

  // https://firebase.google.com/docs/auth/web/auth-state-persistence — a real
  // app chooses one of these; the entry path proves each token resolves.
  await setPersistence(auth, inMemoryPersistence);
  await setPersistence(auth, browserSessionPersistence);
  await setPersistence(auth, browserLocalPersistence);

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
