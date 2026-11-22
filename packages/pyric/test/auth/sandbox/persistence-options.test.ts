/**
 * Regression tests for `#1953`: `initializeAuth(app, deps)` persistence
 * resolution and `auth/already-initialized` enforcement.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { createMemoryBackend } from '../../../src/sandbox/persistence/backends.js';
import {
  browserCookiePersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  type Auth,
} from 'pyric/auth';
import {
  resolveInitializeAuthPersistence,
  resolvePersistenceMode,
} from '../../../src/auth/sandbox/persistence-options.js';

const DEFAULT_SESSION_KEY = 'pyric:sandbox:auth-session';

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

function appSessionKey(appName: string): string {
  return `${DEFAULT_SESSION_KEY}:${encodeURIComponent(`auth-session:${appName}`)}`;
}

async function waitForUserUid(auth: Auth): Promise<string | null> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return auth.currentUser?.uid ?? null;
}

describe('persistence-options helpers', () => {
  it('maps every Firebase persistence marker to its sandbox mode', () => {
    expect(resolvePersistenceMode(inMemoryPersistence, 'setPersistence')).toBe('NONE');
    expect(resolvePersistenceMode(browserSessionPersistence, 'setPersistence')).toBe('SESSION');
    expect(resolvePersistenceMode(browserLocalPersistence, 'setPersistence')).toBe('LOCAL');
    expect(resolvePersistenceMode(indexedDBLocalPersistence, 'setPersistence')).toBe('LOCAL');
    expect(resolvePersistenceMode(browserCookiePersistence, 'setPersistence')).toBe('LOCAL');
  });

  it('rejects unrecognized persistence markers with auth/argument-error', () => {
    expect(() => resolvePersistenceMode({ type: 'BOGUS' }, 'initializeAuth')).toThrow(
      expect.objectContaining({ code: 'auth/argument-error' }),
    );
    expect(() => resolvePersistenceMode(null, 'initializeAuth')).toThrow(
      expect.objectContaining({ code: 'auth/argument-error' }),
    );
  });

  it('resolves omitted, empty, single, and array persistence hierarchies like @firebase/auth', () => {
    const omitted = resolveInitializeAuthPersistence(undefined);
    expect(omitted.mode).toBe('NONE');
    expect([...omitted.restoreModes]).toEqual([]);

    const empty = resolveInitializeAuthPersistence({ persistence: [] });
    expect(empty.mode).toBe('NONE');
    expect([...empty.restoreModes]).toEqual([]);

    const singleSession = resolveInitializeAuthPersistence({
      persistence: browserSessionPersistence,
    });
    expect(singleSession.mode).toBe('SESSION');
    expect([...singleSession.restoreModes]).toEqual(['SESSION']);

    const hierarchy = resolveInitializeAuthPersistence({
      persistence: [browserSessionPersistence, browserLocalPersistence],
    });
    expect(hierarchy.mode).toBe('SESSION');
    expect([...hierarchy.restoreModes].sort()).toEqual(['LOCAL', 'SESSION']);
  });
});

describe('initializeAuth(app, deps) persistence parity (#1953)', () => {
  it('honors inMemoryPersistence and stores nothing in local or session storage', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'init-auth-none',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = initializeAuth(sandbox1, { persistence: inMemoryPersistence });
    await createUserWithEmailAndPassword(auth1, 'mem@example.com', 'password123');
    await sandbox1.flush();

    expect(local.getItem(DEFAULT_SESSION_KEY)).toBeNull();
    expect(session.getItem(DEFAULT_SESSION_KEY)).toBeNull();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'init-auth-none',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = initializeAuth(sandbox2, { persistence: inMemoryPersistence });
    expect(await waitForUserUid(auth2)).toBeNull();

    sandbox1.dispose();
    sandbox2.dispose();
  });

  it('does not restore a previously persisted local session when initialized with inMemoryPersistence', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'init-auth-no-restore',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth1 = getAuth(sandbox1);
    await createUserWithEmailAndPassword(auth1, 'local@example.com', 'password123');
    await sandbox1.flush();
    expect(local.getItem(DEFAULT_SESSION_KEY)).not.toBeNull();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'init-auth-no-restore',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth2 = initializeAuth(sandbox2, { persistence: inMemoryPersistence });
    expect(await waitForUserUid(auth2)).toBeNull();
    expect(local.getItem(DEFAULT_SESSION_KEY)).not.toBeNull();

    sandbox1.dispose();
    sandbox2.dispose();
  });

  it('honors browserSessionPersistence on FirebaseApp handles and isolates from localStorage', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();
    const appName = 'init-session-app';
    const key = appSessionKey(appName);

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({
      key: 'init-auth-session',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const app1 = createAppForSandbox(sandbox1, { projectId: 'demo-init-session' }, appName);
    const auth1 = initializeAuth(app1, { persistence: browserSessionPersistence });
    const cred = await createUserWithEmailAndPassword(auth1, 'sess@example.com', 'password123');
    await sandbox1.flush();

    expect(local.getItem(key)).toBeNull();
    expect(session.getItem(key)).not.toBeNull();

    // Reloading in the same tab (same sessionStorage) restores the user.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({
      key: 'init-auth-session',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const app2 = createAppForSandbox(sandbox2, { projectId: 'demo-init-session' }, appName);
    const auth2 = initializeAuth(app2, { persistence: browserSessionPersistence });
    expect(await waitForUserUid(auth2)).toBe(cred.user.uid);

    // A new tab (fresh sessionStorage) starts signed out.
    const sandbox3 = initializeSandbox();
    await sandbox3.enablePersistence({
      key: 'init-auth-session',
      injectedBackend: backend,
      sessionStorage: { local, session: makeStorage() },
    });
    const app3 = createAppForSandbox(sandbox3, { projectId: 'demo-init-session' }, appName);
    const auth3 = initializeAuth(app3, { persistence: browserSessionPersistence });
    expect(await waitForUserUid(auth3)).toBeNull();

    await deleteApp(app1);
    await deleteApp(app2);
    await deleteApp(app3);
    sandbox1.dispose();
    sandbox2.dispose();
    sandbox3.dispose();
  });

  it('honors persistence array order and allows later setPersistence migration', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'init-auth-array',
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const auth = initializeAuth(sandbox, {
      persistence: [browserSessionPersistence, browserLocalPersistence],
    });
    await createUserWithEmailAndPassword(auth, 'arr@example.com', 'password123');
    expect(session.getItem(DEFAULT_SESSION_KEY)).not.toBeNull();
    expect(local.getItem(DEFAULT_SESSION_KEY)).toBeNull();

    await setPersistence(auth, browserLocalPersistence);
    expect(local.getItem(DEFAULT_SESSION_KEY)).not.toBeNull();
    expect(session.getItem(DEFAULT_SESSION_KEY)).toBeNull();

    sandbox.dispose();
  });

  it('throws auth/already-initialized on conflicting second initializeAuth calls and does not poison on invalid persistence', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'demo-init-dup' }, 'init-dup-app');
    try {
      expect(() => initializeAuth(app, { persistence: { type: 'INVALID' } })).toThrow(
        expect.objectContaining({ code: 'auth/argument-error' }),
      );

      const auth = initializeAuth(app, { persistence: inMemoryPersistence });
      expect(initializeAuth(app, { persistence: inMemoryPersistence })).toBe(auth);
      expect(getAuth(app)).toBe(auth);

      expect(() => initializeAuth(app, { persistence: browserLocalPersistence })).toThrow(
        expect.objectContaining({ code: 'auth/already-initialized' }),
      );
      expect(() => initializeAuth(app)).toThrow(
        expect.objectContaining({ code: 'auth/already-initialized' }),
      );

      await createUserWithEmailAndPassword(auth, 'dup@example.com', 'password123');
      await signInWithEmailAndPassword(auth, 'dup@example.com', 'password123');
      expect(auth.currentUser?.email).toBe('dup@example.com');
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
