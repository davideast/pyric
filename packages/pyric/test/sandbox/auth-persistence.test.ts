/**
 * Auth persistence round-trip tests.
 *
 * Verifies that the persistable-service registry correctly includes auth
 * users in the serialized blob and restores them on a fresh sandbox.
 *
 * Covers:
 *   - Basic round-trip: create users, flush, fresh sandbox restore → users
 *     present without re-creating them.
 *   - Late registration: `enablePersistence` called BEFORE `getAuth` —
 *     the controller's late-registration hook ensures the auth backend is
 *     still included in every subsequent flush.
 *   - Early registration: `getAuth` called BEFORE `enablePersistence` —
 *     the controller subscribes to auth changes on attach.
 *   - Snapshot shape: `sandbox.snapshot().services.auth` contains the
 *     users map.
 *   - Auth changes trigger a debounced flush without a Firestore write.
 *
 * Pattern: uses the injected in-memory backend so tests are fully
 * deterministic and don't depend on IndexedDB or timers beyond the
 * explicit `sandbox.flush()` calls.
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, deserializeFromBuckets, initializeSandbox, type PersistenceBackend } from '../../src/sandbox/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
} from '../../src/auth/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Snapshot shape ────────────────────────────────────────────────────

describe('SandboxSnapshot.services', () => {
  it('is present even when no services are registered', () => {
    const sandbox = initializeSandbox();
    const snap = sandbox.snapshot();
    expect(snap).toHaveProperty('services');
    expect(snap.services).toEqual({});
  });

  it('includes auth users after getAuth is called', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123');

    const snap = sandbox.snapshot();
    expect(snap.services).toHaveProperty('auth');
    const authSnap = snap.services.auth as { users: unknown[] };
    expect(authSnap.users).toHaveLength(1);
  });
});

// ─── Basic round-trip ─────────────────────────────────────────────────

describe('auth persistence — basic round-trip', () => {
  it('restores users after flush → fresh sandbox restore', async () => {
    const backend = createMemoryBackend();

    // Session 1: create two users and flush.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:rt', injectedBackend: backend });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'alice@example.com', 'password123');
    await createUserWithEmailAndPassword(auth1, 'bob@example.com', 'password456');
    await sandbox1.flush();

    // Session 2: fresh sandbox, same backend — users should be restored.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:rt', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const identities = authSandbox.listIdentities(auth2);
    expect(identities).toHaveLength(2);
    const emails = identities.map((i) => i.email).sort();
    expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('restored users can sign in with their original credentials', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:signin', injectedBackend: backend });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'carol@example.com', 'secret');
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:signin', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    // Signing in with the same credentials should succeed.
    const { signInWithEmailAndPassword } = await import('../../src/auth/index.js');
    const cred = await signInWithEmailAndPassword(auth2, 'carol@example.com', 'secret');
    expect(cred.user.email).toBe('carol@example.com');
  });

  it('exportUsers() / listIdentities() agree on restored users', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:export', injectedBackend: backend });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'dave@example.com', 'password123');
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:export', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const exported = authSandbox.exportUsers(auth2);
    const listed = authSandbox.listIdentities(auth2);
    expect(exported).toHaveLength(listed.length);
    expect(exported[0].email).toBe('dave@example.com');
  });
});

// ─── Late registration ─────────────────────────────────────────────────

describe('auth persistence — late registration (enablePersistence before getAuth)', () => {
  it('auth users created after enablePersistence are flushed and restored', async () => {
    const backend = createMemoryBackend();

    // Session 1: enablePersistence FIRST, then getAuth.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:late', injectedBackend: backend });
    // getAuth registers 'auth' AFTER the controller has already attached.
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'eve@example.com', 'latepw123');
    await sandbox1.flush();

    // Session 2: verify restore works.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:late', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const identities = authSandbox.listIdentities(auth2);
    expect(identities).toHaveLength(1);
    expect(identities[0].email).toBe('eve@example.com');
  });

  it('snapshot() includes auth users even when registered after enablePersistence', async () => {
    const backend = createMemoryBackend();
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({ key: 'auth:snap-late', injectedBackend: backend });

    // Late registration.
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'frank@example.com', 'password123');

    const snap = sandbox.snapshot();
    expect(snap.services).toHaveProperty('auth');
    const users = (snap.services.auth as { users: unknown[] }).users;
    expect(users).toHaveLength(1);
  });
});

// ─── Early registration ─────────────────────────────────────────────────

describe('auth persistence — early registration (getAuth before enablePersistence)', () => {
  it('auth changes that fire before enablePersistence are flushed on the next flush', async () => {
    const backend = createMemoryBackend();
    const sandbox = initializeSandbox();

    // getAuth BEFORE enablePersistence.
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'grace@example.com', 'password123');

    await sandbox.enablePersistence({ key: 'auth:early', injectedBackend: backend });
    await sandbox.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:early', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const identities = authSandbox.listIdentities(auth2);
    expect(identities).toHaveLength(1);
    expect(identities[0].email).toBe('grace@example.com');
  });
});

// ─── Auth changes trigger auto-flush without a Firestore write ─────────

describe('auth persistence — auto-flush on auth change', () => {
  it('creating a user triggers a debounced flush even with no Firestore write', async () => {
    const backend = createMemoryBackend();
    let writeCount = 0;
    const counting: PersistenceBackend = {
      getRecord: backend.getRecord.bind(backend),
      listRecords: backend.listRecords.bind(backend),
      putRecords: async (k, r) => { writeCount++; await backend.putRecords(k, r); },
      deleteRecords: backend.deleteRecords.bind(backend),
      clear: backend.clear.bind(backend),
    };

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'auth:autof',
      injectedBackend: counting,
      flushIntervalMs: 20,
    });
    const auth = getAuth(sandbox);

    // Create a user — this triggers the subscribeUsers callback, which
    // schedules the debounced flush. No Firestore write happens.
    await createUserWithEmailAndPassword(auth, 'henry@example.com', 'password123');

    // Before debounce window: flush hasn't fired yet.
    expect(writeCount).toBe(0);

    // After debounce window: snapshot includes the user.
    await sleep(60);
    expect(writeCount).toBeGreaterThan(0);

    const records: [string, unknown][] = [];
    for (const id of await backend.listRecords('auth:autof')) {
      records.push([id, await backend.getRecord('auth:autof', id)]);
    }
    const { services } = deserializeFromBuckets(records);
    const users = (services as { auth?: { users?: unknown[] } }).auth?.users;
    expect(users).toHaveLength(1);
  });
});

// ─── registerPersistableService API guards ──────────────────────────────

describe('registerPersistableService guards', () => {
  it('detaches persistence subscriptions when a service name is unregistered and reused', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'service-reuse',
      injectedBackend: createMemoryBackend(),
      sessionStorage: { local: storage, session: storage },
    });
    let uid = 'first-user';
    let firstNotify: (() => void) | undefined;
    const unregister = sandbox.registerPersistableService('auth-session:named', {
      snapshot: () => null,
      restore: () => {},
      session: {
        currentUid: () => uid,
        restore: () => {},
        mode: () => 'LOCAL',
        subscribe: (notify) => {
          firstNotify = notify;
          return () => { firstNotify = undefined; };
        },
      },
    });
    firstNotify!();
    unregister();

    uid = 'replacement-user';
    let replacementNotify: (() => void) | undefined;
    sandbox.registerPersistableService('auth-session:named', {
      snapshot: () => null,
      restore: () => {},
      session: {
        currentUid: () => uid,
        restore: () => {},
        mode: () => 'LOCAL',
        subscribe: (notify) => {
          replacementNotify = notify;
          return () => { replacementNotify = undefined; };
        },
      },
    });

    expect(replacementNotify).toBeFunction();
    replacementNotify!();
    expect(
      JSON.parse(values.get('pyric:sandbox:auth-session:auth-session%3Anamed')!).uid,
    ).toBe('replacement-user');
  });

  it('throws failed-precondition on duplicate service name', () => {
    const sandbox = initializeSandbox();
    sandbox.registerPersistableService('test-svc', {
      snapshot: () => ({}),
      restore: () => {},
    });
    expect(() => {
      sandbox.registerPersistableService('test-svc', {
        snapshot: () => ({}),
        restore: () => {},
      });
    }).toThrow(/already registered/);
  });

  it('unregister fn removes the service from snapshot', () => {
    const sandbox = initializeSandbox();
    const unregister = sandbox.registerPersistableService('removable', {
      snapshot: () => ({ sentinel: true }),
      restore: () => {},
    });
    expect(sandbox.snapshot().services).toHaveProperty('removable');
    unregister();
    expect(sandbox.snapshot().services).not.toHaveProperty('removable');
  });
});
