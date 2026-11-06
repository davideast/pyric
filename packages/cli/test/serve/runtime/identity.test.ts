import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realAuth from 'firebase/auth';
import { projectRuntimeIdentity } from '../../../src/serve/runtime/identity.js';
import { createLiveIdentity, type LiveAuthHub, type LiveIdentity } from '../../../src/serve/runtime/live-identity.js';

describe('runtime identity', () => {
  it('preserves the profile image through the runtime identity projection', () => {
    expect(projectRuntimeIdentity({ uid: 'alice', photoURL: '/avatars/alice.png' })?.photoURL).toBe('/avatars/alice.png');
    expect(projectRuntimeIdentity({ uid: 'alice', photoURL: null })?.photoURL).toBeNull();
  });

  it('projects auth users onto the shared runtime identity seam', () => {
    expect(projectRuntimeIdentity(null)).toBeNull();
    expect(projectRuntimeIdentity({
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      ignored: true,
    })).toEqual({
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
    });
  });
});

/**
 * Live mode: the page runtime reads the production user from the app's own
 * Auth, which `@pyric/live` lists on the page hub (`Symbol.for('pyric.live.auths')`,
 * `packages/live/src/account.ts`). These tests drive the real `firebase/auth`
 * in production mode: no emulator, a user built by the SDK's own `UserImpl`
 * and made current with `updateCurrentUser`, as a sign-in does. Nothing
 * reaches a network: `fetch` throws if anything calls it.
 */
describe("live identity, read from the app's own Auth", async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
    throw new Error('a test reached the network');
  }) as unknown as typeof fetch);
  const firebaseAuthFile = createRequire(import.meta.url).resolve('firebase/auth');
  const internalFile = createRequire(firebaseAuthFile).resolve('@firebase/auth/internal');
  const { UserImpl } = await import(internalFile) as { UserImpl: { _fromJSON(auth: unknown, json: object): realAuth.User } };
  const options = { apiKey: 'prod-api-key', projectId: 'prod-project', appId: '1:123456789012:web:0a1b2c3d4e5f6071' };
  const app = realApp.initializeApp(options, 'live-identity-production');
  const appAuth = realAuth.getAuth(app);

  function productionUser(uid: string, email: string, displayName: string, providerId: string): realAuth.User {
    return UserImpl._fromJSON(appAuth, {
      uid, email, displayName, emailVerified: true, isAnonymous: false,
      providerData: [{ providerId, uid: `${providerId}-${uid}`, email, displayName, photoURL: null, phoneNumber: null }],
      createdAt: '1700000000000', lastLoginAt: '1700000000000', apiKey: options.apiKey, appName: app.name,
      stsTokenManager: { refreshToken: 'refresh', accessToken: 'opaque-token', expirationTime: Date.now() + 3_600_000 },
    });
  }

  /** Lets the SDK's auth state listeners run. */
  async function settle(): Promise<void> {
    await appAuth.authStateReady();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const hub: LiveAuthHub = { auths: [], listeners: new Set() };
  const store = createLiveIdentity(hub);

  afterAll(async () => {
    store.dispose();
    await realApp.deleteApp(app);
    fetchSpy.mockRestore();
  });

  it('is signed out until the app signs in', async () => {
    await settle();
    expect(store.current()).toBeNull();
    expect(store.recent()).toEqual([]);
  });

  it('knows the uid, email, display name and provider of the user the app signs in, from an Auth noted after the store started', async () => {
    hub.auths.push(appAuth);
    for (const listener of hub.listeners) listener(appAuth);
    const heard: Array<LiveIdentity | null> = [];
    const unsubscribe = store.subscribe((user) => heard.push(user));
    await realAuth.updateCurrentUser(appAuth, productionUser('alice', 'alice@example.com', 'Alice', 'google.com'));
    await settle();
    unsubscribe();
    const alice = { uid: 'alice', email: 'alice@example.com', displayName: 'Alice', providerId: 'google.com' };
    expect(store.current()).toEqual(alice);
    expect(heard.at(-1)).toEqual(alice);
  });

  it("is signed out after the app signs out, and keeps this session's recent users, newest first", async () => {
    await realAuth.updateCurrentUser(appAuth, null);
    await settle();
    expect(store.current()).toBeNull();
    await realAuth.updateCurrentUser(appAuth, productionUser('bob', 'bob@example.com', 'Bob', 'password'));
    await settle();
    await realAuth.updateCurrentUser(appAuth, productionUser('alice', 'alice@example.com', 'Alice', 'google.com'));
    await settle();
    expect(store.recent().map((user) => user.uid)).toEqual(['alice', 'bob']);
    expect(store.recent()[1]).toEqual({ uid: 'bob', email: 'bob@example.com', displayName: 'Bob', providerId: 'password' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads an Auth the hub listed before the store started', async () => {
    const early = createLiveIdentity({ auths: [appAuth], listeners: new Set() });
    await settle();
    expect(early.current()?.uid).toBe('alice');
    early.dispose();
  });

  it('keeps the profile off the page hub', () => {
    expect(hub.auths).toEqual([appAuth]);
    expect(Object.keys(hub).sort()).toEqual(['auths', 'listeners']);
  });
});
