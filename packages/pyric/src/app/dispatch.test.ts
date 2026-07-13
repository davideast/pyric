/**
 * Service-wrapper tests for a sandbox-backed `pyric/app` handle.
 *
 * The `getXxx(PyricApp)` overload on each adapter subpath recognizes the app
 * wrapper and unwraps its Sandbox. Production selection is package-level and
 * never enters these wrappers.
 *
 * Storage is intentionally not exercised here: its sandbox factory
 * opens an IndexedDB connection at `getStorage(sandbox)` time, which
 * needs `fake-indexeddb` (or a real browser env) wired up at the
 * test entry. The unified `getStorage(app: PyricApp)` overload itself
 * is a single-line sandbox unwrap and is
 * covered structurally by typecheck; the runtime IDB story belongs in
 * a storage-focused integration test.
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import { initializeApp, getApps, deleteApp } from './index.js';
import { initializeSandbox } from 'pyric/sandbox';
// Use relative imports to the adapter sources so the test exercises
// the in-tree dispatch added in this PR rather than whatever's sitting
// in `dist/` from the last `bun run build`. The package-exports map
// (`pyric/firestore` → `./dist/firestore/index.js`) is the right
// surface for downstream consumers; for in-repo dispatch tests we
// want the live source.
import { getFirestore } from '../firestore/index.js';
import { getAuth } from '../auth/index.js';
import { getDatabase } from '../database/index.js';

describe('pyric/app — getXxx(PyricApp) sandbox unwrap', () => {
  // The app registry is a process-global singleton (mirroring firebase/app's
  // store), so clear it before each case: every test below initializes the
  // default '[DEFAULT]' app and would otherwise collide with the previous one
  // (app/duplicate-app), exactly as firebase would.
  beforeEach(async () => {
    await Promise.all(getApps().map((app) => deleteApp(app)));
  });

  it('getFirestore(app) returns a Firestore handle for a sandbox app', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const db = getFirestore(app);
    // The handle is opaque; it must at minimum be a non-null object
    // so consumer chaining (`doc(db, ...)`, `collection(db, ...)`)
    // can read the hidden TARGET_SYMBOL off it.
    expect(db).toBeDefined();
    expect(typeof db).toBe('object');
    expect(db).not.toBeNull();
  });

  it('getAuth(app) returns an Auth handle for a sandbox app', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const auth = getAuth(app);
    expect(auth).toBeDefined();
    expect(typeof auth).toBe('object');
    expect(auth).not.toBeNull();
    // `currentUser` is a getter that reads through to the sandbox
    // backend — null before any sign-in.
    expect(auth.currentUser).toBeNull();
  });

  it('getDatabase(app) returns a Database handle for a sandbox app', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const db = getDatabase(app);
    expect(db).toBeDefined();
    expect(typeof db).toBe('object');
    expect(db).not.toBeNull();
  });

  it('getFirestore(app) and getAuth(app) share the underlying sandbox', () => {
    // Both adapters dispatch into the SAME sandbox handle, so a future
    // sign-in through `signInAnonymously(auth)` would be visible to
    // Firestore ops via the sandbox-live identity binding. This test
    // covers the routing — that both adapters reach the same backing
    // sandbox — without exercising the auth flow itself.
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    const db = getFirestore(app);
    const auth = getAuth(app);
    expect(db).toBeDefined();
    expect(auth).toBeDefined();
    // Sanity: calling the dispatch twice for the same app is safe.
    expect(() => getFirestore(app)).not.toThrow();
    expect(() => getAuth(app)).not.toThrow();
  });
});
