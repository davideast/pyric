import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  getAuth,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
} from '../../src/auth/index.js';
import { createMemoryBackend, type WebStorageLike } from '../../src/sandbox/index.js';
import { sandboxForApp } from '../../src/app/runtime.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';

function memoryStorage(): { storage: WebStorageLike; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
  };
}

beforeEach(async () => {
  await resetAppRegistryForTests();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

afterEach(() => resetAppRegistryForTests());

describe('multi-app Auth session persistence', () => {
  it('persists default and named sessions independently regardless of getAuth call order', async () => {
    const defaultApp = initializeApp({ projectId: 'multi-app-persistence' });
    const namedApp = initializeApp({ projectId: 'multi-app-persistence' }, 'named');
    const namedAuth = getAuth(namedApp);
    const defaultAuth = getAuth(defaultApp);
    const local = memoryStorage();
    const session = memoryStorage();

    await sandboxForApp(defaultApp).enablePersistence({
      key: 'multi-app-persistence',
      injectedBackend: createMemoryBackend(),
      sessionStorage: { local: local.storage, session: session.storage },
    });
    authSandbox.seedUsers(defaultAuth, [
      { uid: 'default-user', email: 'default@example.com', password: 'password-123' },
      { uid: 'named-user', email: 'named@example.com', password: 'password-123' },
    ]);
    await signInWithEmailAndPassword(namedAuth, 'named@example.com', 'password-123');
    await signInWithEmailAndPassword(defaultAuth, 'default@example.com', 'password-123');

    expect(JSON.parse(local.values.get('pyric:sandbox:auth-session')!).uid).toBe('default-user');
    expect(
      JSON.parse(local.values.get('pyric:sandbox:auth-session:auth-session%3Anamed')!).uid,
    ).toBe('named-user');
  });

  it('restores a named session when deletion overlaps same-name reinitialization', async () => {
    const options = { projectId: 'overlapping-app-session-persistence' };
    const first = initializeApp(options, 'overlap');
    const firstAuth = getAuth(first);
    const local = memoryStorage();
    const session = memoryStorage();
    await sandboxForApp(first).enablePersistence({
      key: 'overlapping-app-session-persistence',
      injectedBackend: createMemoryBackend(),
      sessionStorage: { local: local.storage, session: session.storage },
    });
    authSandbox.seedUsers(firstAuth, [
      { uid: 'overlap-user', email: 'overlap@example.com', password: 'password-123' },
    ]);
    await signInWithEmailAndPassword(firstAuth, 'overlap@example.com', 'password-123');

    const deleting = deleteApp(first);
    const replacement = initializeApp(options, 'overlap');
    const replacementAuth = getAuth(replacement);
    await deleting;

    expect(replacementAuth.currentUser?.uid).toBe('overlap-user');
  });
});
