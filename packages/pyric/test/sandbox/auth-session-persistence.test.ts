/**
 * Auth session persistence tests (Phase 2).
 *
 * Covers the CURRENT SESSION persistence that honors `setPersistence` mode —
 * which user is signed in survives across sandbox instances (simulating a page
 * reload) when the controller is given a `sessionStorage` option.
 *
 * Key facts:
 *   - Phase 1 (already done): the user DB persists. These tests verify the
 *     SESSION (who is signed in) also persists.
 *   - Phase 2 adds `SandboxPersistenceOptions.sessionStorage` — a pair of
 *     `WebStorageLike` objects (local + session) the controller reads/writes.
 *   - `setPersistence` records the mode on the auth backend. Default = LOCAL.
 *   - The controller reads the mode on every save: LOCAL → local store,
 *     SESSION → session store, NONE → nothing.
 *   - A mode change fires a session-change event, causing the controller to
 *     migrate the stored uid to the new store (or clear it for NONE).
 *
 * Pattern: in-memory Map-backed `WebStorageLike` fakes — no IndexedDB, no
 * real localStorage. Two sandboxes share the SAME backend + SAME storages
 * to simulate "reload" (sandbox2 restores from what sandbox1 flushed).
 */

import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, serializeToBuckets, deserializeFromBuckets, initializeSandbox, type WebStorageLike } from '../../src/sandbox/index.js';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  sandbox as authSandbox,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from '../../src/auth/index.js';

// ─── Test helpers ──────────────────────────────────────────────────────

/**
 * Map-backed web-storage fake. Isolated per test when constructed fresh;
 * shared between two sandboxes to simulate reload (both sandboxes see the
 * same stored bytes).
 */
function makeStorage(): WebStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

/**
 * Helper: wait for `onAuthStateChanged` to fire with a non-null user on the
 * given auth handle. Returns a Promise that resolves with the user. Times out
 * after 1000ms to keep tests from hanging.
 */
function waitForUser(auth: ReturnType<typeof getAuth>): Promise<{ email: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForUser: timed out')), 1000);
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        clearTimeout(timer);
        unsub();
        resolve(user);
      }
    });
  });
}

/**
 * Helper: wait for `onAuthStateChanged` to fire (with any value, incl. null).
 * Used to verify the null/signed-out case.
 */
function waitForAuthState(
  auth: ReturnType<typeof getAuth>,
): Promise<{ email: string | null } | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForAuthState: timed out')), 1000);
    // onAuthStateChanged fires asynchronously with the current value on subscribe.
    const unsub = onAuthStateChanged(auth, (user) => {
      clearTimeout(timer);
      unsub();
      resolve(user);
    });
  });
}

// Session storage key — must match the one in controller.ts.
const SESSION_KEY = 'pyric:sandbox:auth-session';

// ─── Test 1: LOCAL (default) — session survives reload ─────────────────

describe('session persistence — LOCAL mode (default)', () => {
  it('restored sandbox sees the signed-in user via onAuthStateChanged', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Session 1: create a user, sign in, flush.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:local',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'alice@example.com', 'password1');
    // Sign in (creates the session entry).
    await signInWithEmailAndPassword(auth1, 'alice@example.com', 'password1');
    // Flush the user DB to the backend.
    await sandbox1.flush();

    // Verify the uid landed in local (not session) storage.
    expect(local.getItem(SESSION_KEY)).not.toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();

    // Session 2 (simulated reload): fresh sandbox, same backend + storages.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'sess:local',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = getAuth(sandbox2);

    // onAuthStateChanged should fire with the restored user.
    const restoredUser = await waitForUser(auth2);
    expect(restoredUser.email).toBe('alice@example.com');

    // auth.currentUser should also reflect the restored state.
    expect(auth2.currentUser?.email).toBe('alice@example.com');
  });

  it('uid is in local store (not session store) under LOCAL mode', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:local-store',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'bob@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'bob@example.com', 'password1');

    // LOCAL is the default — uid should be in local store.
    const raw = local.getItem(SESSION_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { uid: string };
    expect(parsed.uid).toBeTruthy();
    // Session store should be empty.
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── Test 2: SESSION mode ───────────────────────────────────────────────

describe('session persistence — SESSION mode', () => {
  it('uid lands in session store (not local) after setPersistence(browserSessionPersistence)', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:session-mode',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    // Switch to SESSION mode before signing in.
    await setPersistence(auth, browserSessionPersistence);

    await createUserWithEmailAndPassword(auth, 'carol@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'carol@example.com', 'password1');

    // Uid should be in the session store, not local.
    const raw = session.getItem(SESSION_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { uid: string };
    expect(parsed.uid).toBeTruthy();
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });

  it('session store is read on restore', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Session 1: sign in under SESSION mode.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:session-restore',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = getAuth(sandbox1);
    await setPersistence(auth1, browserSessionPersistence);
    await createUserWithEmailAndPassword(auth1, 'dave@example.com', 'password1');
    await signInWithEmailAndPassword(auth1, 'dave@example.com', 'password1');
    await sandbox1.flush();

    // Uid in session store, not local.
    expect(session.getItem(SESSION_KEY)).not.toBeNull();
    expect(local.getItem(SESSION_KEY)).toBeNull();

    // Session 2: fresh sandbox, same backend + storages — should restore.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'sess:session-restore',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = getAuth(sandbox2);

    const restoredUser = await waitForUser(auth2);
    expect(restoredUser.email).toBe('dave@example.com');
  });
});

// ─── Test 3: NONE mode ─────────────────────────────────────────────────

describe('session persistence — NONE mode', () => {
  it('nothing is stored in either storage slot after setPersistence(inMemoryPersistence)', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:none',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    await setPersistence(auth, inMemoryPersistence);
    await createUserWithEmailAndPassword(auth, 'eve@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'eve@example.com', 'password1');

    // Neither store should have the uid.
    expect(local.getItem(SESSION_KEY)).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });

  it('reload with NONE mode → currentUser is null (no session restored)', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Session 1: sign in under NONE, flush user DB.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:none-reload',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = getAuth(sandbox1);
    await setPersistence(auth1, inMemoryPersistence);
    await createUserWithEmailAndPassword(auth1, 'frank@example.com', 'password1');
    await signInWithEmailAndPassword(auth1, 'frank@example.com', 'password1');
    await sandbox1.flush();

    // Session 2: fresh sandbox, same backend + storages.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'sess:none-reload',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = getAuth(sandbox2);

    // User DB is restored (users present), but session is NOT.
    const identities = authSandbox.listIdentities(auth2);
    expect(identities).toHaveLength(1); // user DB round-tripped fine

    // onAuthStateChanged fires with null (no session).
    const authState = await waitForAuthState(auth2);
    expect(authState).toBeNull();
    expect(auth2.currentUser).toBeNull();
  });
});

// ─── Test 4: Mode migration (LOCAL → SESSION) ──────────────────────────

describe('session persistence — mode migration', () => {
  it('setPersistence(SESSION) after sign-in migrates uid from local to session store', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:migrate',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    // Sign in under LOCAL (default) — uid lands in local store.
    await createUserWithEmailAndPassword(auth, 'grace@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'grace@example.com', 'password1');

    expect(local.getItem(SESSION_KEY)).not.toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();

    // Switch to SESSION mode — should migrate uid to session store.
    await setPersistence(auth, browserSessionPersistence);

    // Local store should be cleared; session store should hold the uid.
    expect(local.getItem(SESSION_KEY)).toBeNull();
    const raw = session.getItem(SESSION_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { uid: string };
    expect(parsed.uid).toBeTruthy();
  });

  it('setPersistence(LOCAL) after SESSION migrates uid back to local store', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:migrate-back',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    // Start under SESSION mode.
    await setPersistence(auth, browserSessionPersistence);
    await createUserWithEmailAndPassword(auth, 'hana@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'hana@example.com', 'password1');

    expect(session.getItem(SESSION_KEY)).not.toBeNull();
    expect(local.getItem(SESSION_KEY)).toBeNull();

    // Switch back to LOCAL — should move uid to local store.
    await setPersistence(auth, browserLocalPersistence);

    expect(session.getItem(SESSION_KEY)).toBeNull();
    expect(local.getItem(SESSION_KEY)).not.toBeNull();
  });

  it('setPersistence(NONE) clears the stored uid from the current store', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:migrate-none',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    // Sign in under LOCAL (default).
    await createUserWithEmailAndPassword(auth, 'ivan@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'ivan@example.com', 'password1');

    expect(local.getItem(SESSION_KEY)).not.toBeNull();

    // Downgrade to NONE — uid should be cleared immediately.
    await setPersistence(auth, inMemoryPersistence);

    expect(local.getItem(SESSION_KEY)).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── Test 5: restoreSession throws (stale uid) ─────────────────────────

describe('session persistence — stale session handling', () => {
  it('clears the stored session and starts unsigned-out when the stored uid is no longer valid', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Session 1: create + sign in a user, flush.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:stale',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = getAuth(sandbox1);
    const cred = await createUserWithEmailAndPassword(auth1, 'jade@example.com', 'password1');
    await signInWithEmailAndPassword(auth1, 'jade@example.com', 'password1');
    await sandbox1.flush();

    const uid = cred.user.uid;
    expect(local.getItem(SESSION_KEY)).not.toBeNull();

    // Simulate "user was deleted from the DB between sessions":
    // Read the blob, strip the user from it, write back.
    const records: [string, unknown][] = [];
    for (const id of await backend.listRecords('sess:stale')) {
      records.push([id, await backend.getRecord('sess:stale', id)]);
    }
    expect(records.length).toBeGreaterThan(0);
    const { firestore, services } = deserializeFromBuckets(records);
    // Remove the user from the services.auth.users array, then re-persist.
    const svc = services as { auth?: { users?: { uid?: string }[] } };
    if (svc.auth?.users) {
      svc.auth.users = svc.auth.users.filter((u) => u.uid !== uid);
    }
    await backend.putRecords('sess:stale', serializeToBuckets(firestore, services, 0));

    // Session 2: the stored uid points to a now-deleted user.
    const warnMessages: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(args); };

    try {
      const sandbox2 = initializeSandbox();
      await sandbox2.enablePersistence({
        key: 'sess:stale',
        injectedBackend: backend,
        sessionStorage: { local, session },
      });
      const auth2 = getAuth(sandbox2);

      // No crash — the controller caught the error and cleared the session.
      const authState = await waitForAuthState(auth2);
      expect(authState).toBeNull();
      expect(auth2.currentUser).toBeNull();

      // Stored session was cleared from both stores.
      expect(local.getItem(SESSION_KEY)).toBeNull();
      expect(session.getItem(SESSION_KEY)).toBeNull();

      // A warning was logged.
      expect(warnMessages.some((m) => {
        const s = String(m);
        return s.includes('session restore') || s.includes(uid);
      })).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('clears stored session when uid exists in session storage but not in the user DB (different stale uid scenario)', async () => {
    // This tests the path where a session uid is stored but the user DB
    // has been seeded with a completely different set of users (e.g., the
    // entire DB was cleared and re-seeded with different users between sessions).
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Pre-plant a session uid in local storage that doesn't exist in any
    // user DB (simulates a stale session from a completely different run).
    local.setItem(SESSION_KEY, JSON.stringify({ uid: 'nonexistent-uid-99999' }));

    // Pre-seed the backend with a valid user DB that does NOT include the stale uid.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'sess:disabled-alt', injectedBackend: backend });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'kate@example.com', 'password1');
    await sandbox1.flush();

    // Session 2: the local storage has a stale uid; the user DB has a different user.
    const warnSpy: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };

    try {
      const sandbox2 = initializeSandbox();
      await sandbox2.enablePersistence({
        key: 'sess:disabled-alt',
        injectedBackend: backend,
        sessionStorage: { local, session },
      });
      const auth2 = getAuth(sandbox2);

      // No session — the stale uid wasn't found.
      const authState = await waitForAuthState(auth2);
      expect(authState).toBeNull();
      expect(auth2.currentUser).toBeNull();

      // Stored session was cleared.
      expect(local.getItem(SESSION_KEY)).toBeNull();
      expect(session.getItem(SESSION_KEY)).toBeNull();
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── Test 6: No sessionStorage injected ────────────────────────────────

describe('session persistence — no sessionStorage injected', () => {
  it('users still persist (Phase 1) but session is NOT restored on reload', async () => {
    const backend = createMemoryBackend();

    // Session 1: create + sign in + flush — NO sessionStorage.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:no-storage',
      injectedBackend: backend,
      // No sessionStorage — session persistence is skipped entirely.
    });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'leo@example.com', 'password1');
    await signInWithEmailAndPassword(auth1, 'leo@example.com', 'password1');
    await sandbox1.flush();

    // Session 2: fresh sandbox, same backend, no sessionStorage.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'sess:no-storage',
      injectedBackend: backend,
      // No sessionStorage.
    });
    const auth2 = getAuth(sandbox2);

    // User DB IS restored — Phase 1 works.
    const identities = authSandbox.listIdentities(auth2);
    expect(identities).toHaveLength(1);
    expect(identities[0].email).toBe('leo@example.com');

    // Session is NOT restored — currentUser is null.
    const authState = await waitForAuthState(auth2);
    expect(authState).toBeNull();
    expect(auth2.currentUser).toBeNull();
  });
});

// ─── Test 7: Sign-out clears the stored session ────────────────────────

describe('session persistence — sign-out', () => {
  it('signOut clears the stored session from both stores', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'sess:signout',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = getAuth(sandbox);

    await createUserWithEmailAndPassword(auth, 'mia@example.com', 'password1');
    await signInWithEmailAndPassword(auth, 'mia@example.com', 'password1');

    expect(local.getItem(SESSION_KEY)).not.toBeNull();

    await signOut(auth);

    // Both stores should be empty after sign-out.
    expect(local.getItem(SESSION_KEY)).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── Test 8: Late registration (enablePersistence before getAuth) ───────

describe('session persistence — late registration', () => {
  it('session is still saved when getAuth is called after enablePersistence', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    // Session 1: enablePersistence FIRST, then getAuth (late registration).
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'sess:late',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    // getAuth registers 'auth' AFTER the controller attached.
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'nina@example.com', 'password1');
    await signInWithEmailAndPassword(auth1, 'nina@example.com', 'password1');
    await sandbox1.flush();

    // The session should have been saved even though auth registered late.
    expect(local.getItem(SESSION_KEY)).not.toBeNull();

    // Session 2: restore should also work.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'sess:late',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = getAuth(sandbox2);

    const restoredUser = await waitForUser(auth2);
    expect(restoredUser.email).toBe('nina@example.com');
  });
});
