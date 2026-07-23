/**
 * Tests for `pyric-admin/auth`.
 *
 * Covers:
 *   - Phase 3 dispatch: branded `PyricAdminApp` from `pyric-admin/app`
 *     routes to the right backend (`prod` → firebase-admin/auth;
 *     `sandbox` → in-memory backend). Inputs that aren't a
 *     `PyricAdminApp` throw a clear `TypeError`.
 *   - Phase 4b sandbox backend: roundtrips for createCustomToken /
 *     verifyIdToken, createUser / getUser / getUserByEmail / deleteUser,
 *     setCustomUserClaims persistence, and that `sandbox.reset()` clears
 *     the in-memory user store.
 *   - Documented "not implemented" surface throws the canonical
 *     `not implemented in pyric-admin/auth sandbox backend` message.
 */

import { afterEach, describe, it, expect } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';

import { initializeApp, deleteApp, getApps, ADMIN_APP_TARGET } from '../app/index.js';
import { getAuth, SANDBOX_TOKEN_PREFIX } from './index.js';

// The app registry is module-global (mirror of firebase-admin's
// defaultAppStore) — deregister every app after each test so unnamed
// `initializeApp({ sandbox })` calls don't collide across tests.
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('getAuth — Phase 3 dispatch', () => {
  it('rejects values that are not PyricAdminApp with a clear TypeError', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAuth(null as any)).toThrow(TypeError);
    // `undefined` is the no-arg mirror: it resolves the default app from
    // the registry and (with none initialized) throws firebase-admin's
    // app/no-app error, not the entry-guard TypeError.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAuth(undefined as any)).toThrow(
      /The default Firebase app does not exist/,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAuth({} as any)).toThrow(/ADMIN_APP_TARGET brand/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAuth('not an app' as any)).toThrow(TypeError);
  });

  it('rejects PyricAdminApp-shaped values with an unknown target string', () => {
    // Manually-constructed handle with an unrecognized target value —
    // simulates a future `pyric-admin/app` adding a new arm that this
    // adapter hasn't been updated for. The error names the offending
    // target so the remediation is obvious.
    const futureApp = {
      [ADMIN_APP_TARGET]: 'replay' as const,
      // Carry a stub `sandbox` so it doesn't fail the prod-arm cast.
      sandbox: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(() => getAuth(futureApp)).toThrow(/expected a sandbox admin app/);
  });

  it('returns a sandbox Auth handle for a sandbox-target PyricAdminApp', () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    const auth = getAuth(app);
    // The sandbox handle exposes the documented method subset as
    // callable functions. Cast through unknown — the Auth type is the
    // upstream class; the sandbox returns a structurally-compatible
    // duck.
    const a = auth as unknown as Record<string, unknown>;
    expect(typeof a.createCustomToken).toBe('function');
    expect(typeof a.verifyIdToken).toBe('function');
    expect(typeof a.createUser).toBe('function');
    expect(typeof a.getUser).toBe('function');
    expect(typeof a.getUserByEmail).toBe('function');
    expect(typeof a.deleteUser).toBe('function');
    expect(typeof a.setCustomUserClaims).toBe('function');
  });
});

describe('sandbox backend — createCustomToken / verifyIdToken roundtrip', () => {
  it('mints a deterministic token with the documented prefix', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const token = await auth.createCustomToken('alice');
    expect(token.startsWith(`${SANDBOX_TOKEN_PREFIX}:`)).toBe(true);
    expect(token).toBe(`${SANDBOX_TOKEN_PREFIX}:alice:{}`);
  });

  it('round-trips uid + claims through verifyIdToken', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const token = await auth.createCustomToken('alice', { role: 'admin', tier: 2 });
    const decoded = await auth.verifyIdToken(token);
    expect(decoded.uid).toBe('alice');
    expect(decoded.sub).toBe('alice');
    expect(decoded.role).toBe('admin');
    expect(decoded.tier).toBe(2);
    // Required DecodedIdToken fields are populated with sandbox placeholders.
    expect(decoded.iss).toBe('pyric-sandbox');
    expect(decoded.aud).toBe('pyric-sandbox');
    expect(decoded.firebase.sign_in_provider).toBe('custom');
  });

  it('rejects tokens that do not carry the sandbox prefix', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    // A real-looking JWT — three base64 segments joined by '.'. The
    // sandbox backend doesn't try to parse JWTs; it only accepts its
    // own minted tokens.
    const realJwt = 'eyJhbGciOi.eyJzdWIiOi.signature';
    await expect(auth.verifyIdToken(realJwt)).rejects.toThrow(
      /sandbox.*createCustomToken/,
    );
  });

  it('rejects tokens with malformed claim JSON', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const badToken = `${SANDBOX_TOKEN_PREFIX}:alice:not-json`;
    await expect(auth.verifyIdToken(badToken)).rejects.toThrow(/JSON/);
  });

  it('verifies client ID tokens minted with sandbox-id-token prefix', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const clientClaims = { sub: 'bob', role: 'editor', firebase: { sign_in_provider: 'google.com' } };
    const clientToken = `sandbox-id-token-bob-1:${JSON.stringify(clientClaims)}`;
    const decoded = await auth.verifyIdToken(clientToken);
    expect(decoded.uid).toBe('bob');
    expect(decoded.sub).toBe('bob');
    expect(decoded.role).toBe('editor');
    expect(decoded.firebase.sign_in_provider).toBe('google.com');
    expect(decoded.iss).toBe('https://sandbox.pyric.dev');
    expect(decoded.aud).toBe('pyric-sandbox');
  });

  it('rejects client ID tokens with malformed claim JSON', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const badToken = 'sandbox-id-token-bob-1:not-json';
    await expect(auth.verifyIdToken(badToken)).rejects.toThrow(/JSON/);
  });
});


describe('sandbox backend — user CRUD', () => {
  it('createUser stores by uid; getUser retrieves it', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const created = await auth.createUser({
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
    });
    expect(created.uid).toBe('alice');
    expect(created.email).toBe('alice@example.com');
    expect(created.displayName).toBe('Alice');
    expect(created.disabled).toBe(false);
    expect(created.emailVerified).toBe(false);

    const fetched = await auth.getUser('alice');
    expect(fetched.uid).toBe('alice');
    expect(fetched.email).toBe('alice@example.com');
  });

  it('createUser auto-generates a uid when omitted', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    const created = await auth.createUser({ email: 'noid@example.com' });
    expect(created.uid).toMatch(/^pyric-sandbox-/);
    // Round-trips: the auto-uid is retrievable.
    const fetched = await auth.getUser(created.uid);
    expect(fetched.email).toBe('noid@example.com');
  });

  it('createUser rejects on uid collision', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await expect(auth.createUser({ uid: 'alice' })).rejects.toThrow(/already exists/);
  });

  it('getUserByEmail finds users by email via linear scan', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice', email: 'a@e.com' });
    await auth.createUser({ uid: 'bob', email: 'b@e.com' });
    const fetched = await auth.getUserByEmail('b@e.com');
    expect(fetched.uid).toBe('bob');
  });

  it('getUserByEmail rejects on miss', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await expect(auth.getUserByEmail('nobody@e.com')).rejects.toThrow(
      /no user with email/,
    );
  });

  it('getUser rejects on miss', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await expect(auth.getUser('ghost')).rejects.toThrow(/no user with uid/);
  });

  it('deleteUser removes the record', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await auth.deleteUser('alice');
    await expect(auth.getUser('alice')).rejects.toThrow(/no user/);
  });

  it('deleteUser rejects on miss', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await expect(auth.deleteUser('ghost')).rejects.toThrow(/no user with uid/);
  });
});

describe('sandbox backend — setCustomUserClaims persistence', () => {
  it('persists claims and getUser reads them back', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await auth.setCustomUserClaims('alice', { role: 'admin', org: 'acme' });
    const fetched = await auth.getUser('alice');
    expect(fetched.customClaims).toEqual({ role: 'admin', org: 'acme' });
  });

  it('passing null clears claims', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await auth.setCustomUserClaims('alice', { role: 'admin' });
    await auth.setCustomUserClaims('alice', null);
    const fetched = await auth.getUser('alice');
    expect(fetched.customClaims).toBeUndefined();
  });

  it('claims minted via setCustomUserClaims surface through createCustomToken + verifyIdToken', async () => {
    // The token format is stateless (claims are baked in at mint time
    // by the caller, not pulled from the store), so this test is
    // really asserting the caller's pattern: read claims off the
    // UserRecord, pass them through to createCustomToken.
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await auth.setCustomUserClaims('alice', { role: 'admin' });
    const stored = await auth.getUser('alice');
    const token = await auth.createCustomToken(
      stored.uid,
      stored.customClaims ?? {},
    );
    const decoded = await auth.verifyIdToken(token);
    expect(decoded.role).toBe('admin');
  });

  it('setCustomUserClaims rejects on missing user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await expect(auth.setCustomUserClaims('ghost', { x: 1 })).rejects.toThrow(
      /no user with uid/,
    );
  });
});

describe('sandbox backend — reset clears state', () => {
  it('sandbox.reset() wipes the auth user store', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice', email: 'a@e.com' });
    // Confirm pre-reset state.
    const before = await auth.getUser('alice');
    expect(before.uid).toBe('alice');

    sandbox.reset();

    // After reset, the same auth handle should see no users.
    await expect(auth.getUser('alice')).rejects.toThrow(/no user with uid/);
  });

  it('repeat getAuth(app) calls share the same in-memory store', async () => {
    // Mirrors firebase-admin's `getAuth(app)` idempotency — writes
    // through one handle are visible through another for the same
    // sandbox.
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    const auth1 = getAuth(app);
    const auth2 = getAuth(app);
    await auth1.createUser({ uid: 'alice' });
    const fetched = await auth2.getUser('alice');
    expect(fetched.uid).toBe('alice');
  });
});

describe('sandbox backend — explicitly-not-implemented surface', () => {
  it('updateUser throws the canonical not-implemented message', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (auth as any).updateUser('alice', { displayName: 'A' }),
    ).rejects.toThrow(/not implemented in pyric-admin\/auth sandbox backend/);
  });

  it.each([
    'getUserByPhoneNumber',
    'getUserByProviderUid',
    'getUsers',
    'deleteUsers',
    'listUsers',
    'importUsers',
    'revokeRefreshTokens',
    'createSessionCookie',
    'verifySessionCookie',
    'generatePasswordResetLink',
    'generateEmailVerificationLink',
    'generateSignInWithEmailLink',
    'generateVerifyAndChangeEmailLink',
    'createProviderConfig',
    'getProviderConfig',
    'listProviderConfigs',
    'updateProviderConfig',
    'deleteProviderConfig',
  ])('%s rejects with the not-implemented message', async (method) => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (auth as any)[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(fn.call(auth)).rejects.toThrow(
      /not implemented in pyric-admin\/auth sandbox backend/,
    );
  });

  it('tenantManager getter throws the not-implemented message', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    expect(() => (auth as Record<string, unknown>)['tenantManager']).toThrow(
      /not implemented in pyric-admin\/auth sandbox backend/,
    );
  });
});

