/**
 * Service-wrapper tests for a sandbox-backed `pyric/app` handle.
 *
 * Each `getXxx(FirebaseApp)` overload recognizes a privately-associated Pyric
 * app container and resolves its shared sandbox backend.
 *
 * fake-indexeddb supplies the browser persistence primitive Storage needs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import 'fake-indexeddb/auto';

import { initializeApp } from './index.js';
import { resetAppRegistryForTests } from './registry.js';
// Use relative imports to the adapter sources so the test exercises
// the in-tree dispatch added in this PR rather than whatever's sitting
// in `dist/` from the last `bun run build`. The package-exports map
// (`pyric/firestore` → `./dist/firestore/index.js`) is the right
// surface for downstream consumers; for in-repo dispatch tests we
// want the live source.
import { getFirestore } from '../firestore/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from '../auth/index.js';
import { get, getDatabase, ref, set } from '../database/index.js';
import { getStorage } from '../storage/index.js';
import { getAI } from '../ai/index.js';
import { getMessaging } from '../messaging/index.js';

describe('pyric/app — Firebase-shaped service containers', () => {
  const options = { apiKey: 'ignored-in-sandbox', projectId: 'demo-project' };
  // The app registry is a process-global singleton (mirroring firebase/app's
  // store). Use the test-only full reset here: deleteApp() intentionally keeps
  // the one-runtime backend/config lock alive, which must not leak across test
  // files when Bun schedules them in a different order.
  beforeEach(() => resetAppRegistryForTests());

  afterEach(() => resetAppRegistryForTests());

  it('getFirestore(app) returns a Firestore handle for a sandbox app', () => {
    const app = initializeApp(options);
    const db = getFirestore(app);
    // The handle is opaque; it must at minimum be a non-null object
    // so consumer chaining (`doc(db, ...)`, `collection(db, ...)`)
    // can read the hidden TARGET_SYMBOL off it.
    expect(db).toBeDefined();
    expect(typeof db).toBe('object');
    expect(db).not.toBeNull();
    expect(db.app).toBe(app);
  });

  it('getAuth(app) returns an Auth handle for a sandbox app', () => {
    const app = initializeApp(options);
    const auth = getAuth(app);
    expect(auth).toBeDefined();
    expect(typeof auth).toBe('object');
    expect(auth).not.toBeNull();
    // `currentUser` is a getter that reads through to the sandbox
    // backend — null before any sign-in.
    expect(auth.currentUser).toBeNull();
    expect(auth.app).toBe(app);
  });

  it('getDatabase(app) returns a Database handle for a sandbox app', () => {
    const app = initializeApp(options);
    const db = getDatabase(app);
    expect(db).toBeDefined();
    expect(typeof db).toBe('object');
    expect(db).not.toBeNull();
    expect(db.app).toBe(app);
  });

  it('getFirestore(app) and getAuth(app) share the underlying sandbox', () => {
    // Both adapters dispatch into the same app runtime and backing sandbox.
    const app = initializeApp(options);
    const db = getFirestore(app);
    const auth = getAuth(app);
    expect(db).toBeDefined();
    expect(auth).toBeDefined();
    // Sanity: calling the dispatch twice for the same app is safe.
    expect(() => getFirestore(app)).not.toThrow();
    expect(() => getAuth(app)).not.toThrow();
  });

  it('Firebase-shaped service factories resolve the default app when omitted', () => {
    const app = initializeApp(options);

    expect(getAuth().app).toBe(app);
    expect(getFirestore().app).toBe(app);
    expect(getDatabase().app).toBe(app);
    expect(getStorage().app).toBe(app);
    expect(getAI().app).toBe(app);
    expect(getMessaging().app).toBe(app);
  });

  it('equal-config named apps own distinct services over shared data', () => {
    const a = initializeApp(options);
    const b = initializeApp({ ...options }, 'secondary');
    expect(getFirestore(a)).not.toBe(getFirestore(b));
    expect(getAuth(a)).not.toBe(getAuth(b));
    expect(getDatabase(a)).not.toBe(getDatabase(b));
    expect(getStorage(a)).not.toBe(getStorage(b));
    expect(getAI(a)).not.toBe(getAI(b));
    expect(getMessaging(a)).not.toBe(getMessaging(b));
  });

  it('equal-config named apps keep independent auth sessions over shared data', async () => {
    const a = initializeApp(options);
    const b = initializeApp({ ...options }, 'secondary');
    const authA = getAuth(a);
    const authB = getAuth(b);

    await signInAnonymously(authA);

    expect(authA.currentUser).not.toBeNull();
    expect(authB.currentUser).toBeNull();

    const dbA = getDatabase(a);
    const dbB = getDatabase(b);
    await set(ref(dbA, 'shared/value'), { from: authA.currentUser!.uid });
    expect((await get(ref(dbB, 'shared/value'))).val()).toEqual({ from: authA.currentUser!.uid });
  });

  it('equal-config named apps share the auth user store, not the active session', async () => {
    const a = initializeApp(options);
    const b = initializeApp({ ...options }, 'secondary');
    const authA = getAuth(a);
    const authB = getAuth(b);

    const created = await createUserWithEmailAndPassword(authA, 'shared@example.com', 'password-123');
    await signOut(authA);
    const signedIn = await signInWithEmailAndPassword(authB, 'shared@example.com', 'password-123');

    expect(signedIn.user.uid).toBe(created.user.uid);
    expect(authA.currentUser).toBeNull();
    expect(authB.currentUser).toBe(signedIn.user);
  });
});
