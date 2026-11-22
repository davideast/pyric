/**
 * Regression coverage for #1540: `Auth.authStateReady()` resolves once the
 * initial auth state settles on both bare-sandbox and FirebaseApp Auth handles.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from '../../src/sandbox/index.js';
import { deleteApp, getApps } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  initializeAuth,
  signInAnonymously,
  signOut,
} from '../../src/auth/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe('Auth.authStateReady (#1540)', () => {
  it('resolves to undefined after initial auth state settles when signed out', async () => {
    const auth = getAuth(initializeSandbox());
    expect(typeof auth.authStateReady).toBe('function');

    let resolvedSynchronously = false;
    const pending = auth.authStateReady().then((value) => {
      resolvedSynchronously = true;
      return value;
    });
    expect(resolvedSynchronously).toBe(false);

    const result = await pending;
    expect(result).toBeUndefined();
    expect(auth.currentUser).toBeNull();

    // Subsequent calls also resolve cleanly while still signed out.
    expect(await auth.authStateReady()).toBeUndefined();
  });

  it('resolves with the signed-in currentUser and supports concurrent callers', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'ready-app' }, 'ready-app');
    const auth = initializeAuth(app, { persistence: browserLocalPersistence });

    const created = await signInAnonymously(auth);
    const [first, second] = await Promise.all([
      auth.authStateReady(),
      auth.authStateReady(),
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(auth.currentUser?.uid).toBe(created.user.uid);

    await signOut(auth);
    expect(await auth.authStateReady()).toBeUndefined();
    expect(auth.currentUser).toBeNull();
  });

  it('sees a persisted session restored onto a fresh sandbox', async () => {
    const backend = createMemoryBackend();
    const local = makeStorage();
    const session = makeStorage();
    const key = 'auth-state-ready-restore';

    const firstSandbox = initializeSandbox();
    await firstSandbox.enablePersistence({
      key,
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const firstAuth = getAuth(firstSandbox);
    const { user } = await createUserWithEmailAndPassword(
      firstAuth,
      'persisted@example.com',
      'pw-123456',
    );
    await firstSandbox.flush();

    const secondSandbox = initializeSandbox();
    await secondSandbox.enablePersistence({
      key,
      injectedBackend: backend,
      sessionStorage: { local, session },
    });
    const secondAuth = getAuth(secondSandbox);

    await secondAuth.authStateReady();
    expect(secondAuth.currentUser?.uid).toBe(user.uid);
    expect(secondAuth.currentUser?.email).toBe('persisted@example.com');

    firstSandbox.dispose();
    secondSandbox.dispose();
  });

  it('rejects with app/app-deleted when called after deleteApp', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'deleted-ready' }, 'deleted-ready');
    const auth = getAuth(app);
    await deleteApp(app);

    await expect(auth.authStateReady()).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
  });
});
