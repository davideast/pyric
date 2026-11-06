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
import { getClock, idTokenAudience, mintIdToken, SANDBOX_PROJECT_ID } from 'pyric/sandbox/internal';

import { initializeApp, deleteApp, getApps, ADMIN_APP_TARGET } from '../app/index.js';
import { getAuth } from './index.js';

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

describe('sandbox backend — createCustomToken', () => {
  // The token's shape and its exchange: custom-token-exchange.test.ts (#1952).
  it('mints the same token for the same uid, claims and sandbox time', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    expect(await auth.createCustomToken('alice')).toBe(await auth.createCustomToken('alice'));
  });
});

// #1949: verifyIdToken checks a token as firebase-admin 13.10.0 does
// (lib/auth/token-verifier.js verifyJWT, verifyContent, verifySignature):
// the argument's type synchronously, then decoding, `kid`, `alg`, `aud`,
// `iss`, `sub`, the signature, and last `nbf` and `exp`.
const DOCS = ' See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.';
const PROJECT_MATCH = ' Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.';
const DECODE_FAILED = `Decoding Firebase ID token failed. Make sure you passed the entire string JWT which represents an ID token.${DOCS}`;
const BAD_SIGNATURE = `Firebase ID token has invalid signature.${DOCS}`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The claims of an ID token pyric's Auth mints for `projectId`, with `overrides` on top. */
function idTokenClaims(overrides: Record<string, unknown> = {}, projectId = SANDBOX_PROJECT_ID): Record<string, unknown> {
  const now = nowSeconds();
  return {
    ...idTokenAudience(projectId),
    sub: 'alice',
    user_id: 'alice',
    iat: now,
    auth_time: now,
    exp: now + 3600,
    firebase: { identities: {}, sign_in_provider: 'custom' },
    ...overrides,
  };
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** A JWT with any header and claims and no valid signature. */
function unsignedJwt(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  return `${segment(header)}.${segment(claims)}.c2lnbmF0dXJl`;
}

function sandboxAuth(projectId?: string) {
  const sandbox = initializeSandbox();
  const options = projectId === undefined ? { sandbox } : { sandbox, projectId };
  return { sandbox, auth: getAuth(initializeApp(options)) };
}

function argumentError(message: string) {
  return { code: 'auth/argument-error', message };
}

describe('sandbox backend — verifyIdToken verifies ID tokens only', () => {
  it('verifies the ID token a client gets from a custom-token sign-in, with the claims', async () => {
    const { getAuth: getClientAuth, signInWithCustomToken } = await import('pyric/auth');
    const { sandbox, auth } = sandboxAuth();
    const customToken = await auth.createCustomToken('alice', { role: 'admin', tier: 2 });
    const { user } = await signInWithCustomToken(getClientAuth(sandbox), customToken);
    const decoded = await auth.verifyIdToken(await user.getIdToken());
    expect(decoded.uid).toBe('alice');
    expect(decoded.sub).toBe('alice');
    expect(decoded.role).toBe('admin');
    expect(decoded.tier).toBe(2);
    expect(decoded.iss).toBe('https://securetoken.google.com/pyric-sandbox');
    expect(decoded.aud).toBe('pyric-sandbox');
    expect(decoded.firebase.sign_in_provider).toBe('custom');
  });

  it("verifies an ID token minted for the admin app's own project", async () => {
    const { auth } = sandboxAuth('demo-verify');
    const decoded = await auth.verifyIdToken(mintIdToken(idTokenClaims({}, 'demo-verify')));
    expect(decoded.uid).toBe('alice');
    expect(decoded.aud).toBe('demo-verify');
  });

  it('rejects a custom token with auth/argument-error, as production does', async () => {
    const { auth } = sandboxAuth();
    const customToken = await auth.createCustomToken('victim', { admin: true });
    await expect(auth.verifyIdToken(customToken)).rejects.toMatchObject(
      argumentError(`verifyIdToken() expects an ID token, but was given a custom token.${DOCS}`),
    );
  });

  it('rejects a plain string with auth/argument-error', async () => {
    const { auth } = sandboxAuth();
    for (const token of ['not a token', 'pyric-sandbox-custom:victim-uid:{"admin":true}', 'sandbox-id-token-bob-1:{"sub":"bob"}', '']) {
      await expect(auth.verifyIdToken(token)).rejects.toMatchObject(argumentError(DECODE_FAILED));
    }
  });

  it('rejects a JWT whose header and payload do not decode as JSON', async () => {
    const { auth } = sandboxAuth();
    await expect(auth.verifyIdToken('eyJhbGciOi.eyJzdWIiOi.signature')).rejects.toMatchObject(argumentError(DECODE_FAILED));
  });

  it('throws auth/argument-error synchronously when the token is not a string', () => {
    const { auth } = sandboxAuth();
    let thrown: unknown;
    try {
      void auth.verifyIdToken(42 as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject(argumentError('First argument to verifyIdToken() must be a Firebase ID token string.'));
  });

  it('rejects a forged token, whose claims were edited after signing', async () => {
    const { auth } = sandboxAuth();
    const [header, , signature] = mintIdToken(idTokenClaims()).split('.');
    const forged = `${header}.${segment(idTokenClaims({ sub: 'victim', user_id: 'victim', admin: true }))}.${signature}`;
    await expect(auth.verifyIdToken(forged)).rejects.toMatchObject(argumentError(BAD_SIGNATURE));
  });

  it('rejects a token with no signature', async () => {
    const { auth } = sandboxAuth();
    const [header, payload] = mintIdToken(idTokenClaims()).split('.');
    await expect(auth.verifyIdToken(`${header}.${payload}.`)).rejects.toMatchObject(argumentError(BAD_SIGNATURE));
  });

  it('rejects an expired token with auth/id-token-expired', async () => {
    const { auth } = sandboxAuth();
    const expired = mintIdToken(idTokenClaims({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 }));
    await expect(auth.verifyIdToken(expired)).rejects.toMatchObject({
      code: 'auth/id-token-expired',
      message: `Firebase ID token has expired. Get a fresh ID token from your client app and try again (auth/id-token-expired).${DOCS}`,
    });
  });

  it('reads expiry on the sandbox clock', async () => {
    const { sandbox, auth } = sandboxAuth();
    const token = mintIdToken(idTokenClaims());
    await expect(auth.verifyIdToken(token)).resolves.toMatchObject({ uid: 'alice' });
    getClock(sandbox).advance(61 * 60 * 1000);
    await expect(auth.verifyIdToken(token)).rejects.toMatchObject({ code: 'auth/id-token-expired' });
  });

  it('rejects a token that is not yet valid', async () => {
    const { auth } = sandboxAuth();
    const early = mintIdToken(idTokenClaims({ nbf: nowSeconds() + 3600 }));
    await expect(auth.verifyIdToken(early)).rejects.toMatchObject(argumentError(BAD_SIGNATURE));
  });

  it('rejects a token for another project', async () => {
    const { auth } = sandboxAuth('demo-verify');
    const other = mintIdToken(idTokenClaims({}, 'demo-other'));
    await expect(auth.verifyIdToken(other)).rejects.toMatchObject(
      argumentError(`Firebase ID token has incorrect "aud" (audience) claim. Expected "demo-verify" but got "demo-other".${PROJECT_MATCH}${DOCS}`),
    );
  });

  it('checks the project against pyric-sandbox when the admin app names none', async () => {
    const { auth } = sandboxAuth();
    const other = mintIdToken(idTokenClaims({}, 'demo-other'));
    await expect(auth.verifyIdToken(other)).rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('rejects a token whose issuer names another project', async () => {
    const { auth } = sandboxAuth('demo-verify');
    const token = mintIdToken(idTokenClaims({ iss: 'https://securetoken.google.com/demo-other' }, 'demo-verify'));
    await expect(auth.verifyIdToken(token)).rejects.toMatchObject(
      argumentError(`Firebase ID token has incorrect "iss" (issuer) claim. Expected "https://securetoken.google.com/demo-verify" but got "https://securetoken.google.com/demo-other".${PROJECT_MATCH}${DOCS}`),
    );
  });

  it('rejects a token with a missing, empty or over-long subject', async () => {
    const { auth } = sandboxAuth();
    const cases: Array<[unknown, string]> = [
      [undefined, `Firebase ID token has no "sub" (subject) claim.${DOCS}`],
      ['', `Firebase ID token has an empty "sub" (subject) claim.${DOCS}`],
      ['x'.repeat(129), `Firebase ID token has a "sub" (subject) claim longer than 128 characters.${DOCS}`],
    ];
    for (const [sub, message] of cases) {
      await expect(auth.verifyIdToken(mintIdToken(idTokenClaims({ sub })))).rejects.toMatchObject(argumentError(message));
    }
    await expect(auth.verifyIdToken(mintIdToken(idTokenClaims({ sub: 'x'.repeat(128) })))).resolves.toMatchObject({ uid: 'x'.repeat(128) });
  });

  it('rejects a token whose algorithm is not RS256', async () => {
    const { auth } = sandboxAuth();
    for (const alg of ['none', 'HS256']) {
      const token = unsignedJwt({ alg, kid: 'pyric-sandbox', typ: 'JWT' }, idTokenClaims());
      await expect(auth.verifyIdToken(token)).rejects.toMatchObject(
        argumentError(`Firebase ID token has incorrect algorithm. Expected "RS256" but got "${alg}".${DOCS}`),
      );
    }
  });

  it('rejects a token whose kid is not a key id', async () => {
    const { auth } = sandboxAuth();
    for (const kid of [42, ['another-key']]) {
      const token = unsignedJwt({ alg: 'RS256', kid, typ: 'JWT' }, idTokenClaims());
      await expect(auth.verifyIdToken(token)).rejects.toMatchObject(
        argumentError('Firebase ID token has "kid" claim which does not correspond to a known public key. Most likely the ID token is expired, so get a fresh token from your client app and try again.'),
      );
    }
  });

  it('rejects a token whose kid names another key as a production token, keeping the code (#2304)', async () => {
    const { auth } = sandboxAuth();
    const token = unsignedJwt({ alg: 'RS256', kid: 'another-key', typ: 'JWT' }, idTokenClaims());
    await expect(auth.verifyIdToken(token)).rejects.toMatchObject({ code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' });
  });

  it('rejects a token with no kid, naming a custom token when it is one', async () => {
    const { auth } = sandboxAuth();
    const noKid = unsignedJwt({ alg: 'RS256', typ: 'JWT' }, idTokenClaims());
    await expect(auth.verifyIdToken(noKid)).rejects.toMatchObject(argumentError(`Firebase ID token has no "kid" claim.${DOCS}`));
    const customAudience = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
    const jwtCustomToken = unsignedJwt({ alg: 'RS256', typ: 'JWT' }, { aud: customAudience, uid: 'victim', sub: 'svc', iss: 'svc' });
    await expect(auth.verifyIdToken(jwtCustomToken)).rejects.toMatchObject(
      argumentError(`verifyIdToken() expects an ID token, but was given a custom token.${DOCS}`),
    );
  });

  // #1836: a display name with a space or outside Latin-1 used to reach the token text.
  for (const displayName of ['Builder One', '李']) {
    it(`verifies the JWT a user named ${displayName} gets, as minted, through a Bearer header`, async () => {
      const { getAuth: getClientAuth, signInWithEmailAndPassword, updateProfile, sandbox: clientAuthSandbox } = await import('pyric/auth');
      const sandbox = initializeSandbox();
      const clientAuth = getClientAuth(sandbox);
      clientAuthSandbox.createUser(clientAuth, { email: 'builder@example.com', password: 'secret-pw' });
      const { user } = await signInWithEmailAndPassword(clientAuth, 'builder@example.com', 'secret-pw');
      await updateProfile(user, { displayName });
      const idToken = await user.getIdToken(true);
      const header = new Headers({ Authorization: `Bearer ${idToken}` }).get('Authorization') ?? '';
      const decoded = await getAuth(initializeApp({ sandbox })).verifyIdToken(header.split(' ')[1] ?? '');
      const { claims } = await user.getIdTokenResult();
      expect(decoded).toEqual({ ...claims, uid: user.uid } as typeof decoded);
      expect(decoded.name).toBe(displayName);
    });
  }

  it('verifies a signed-in client token with the account standard claims', async () => {
    const { getAuth: getClientAuth, signInWithEmailAndPassword, sandbox: clientAuthSandbox } = await import('pyric/auth');
    const sandbox = initializeSandbox();
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.createUser(clientAuth, { email: 'ada@example.com', password: 'secret-pw', emailVerified: true });
    const { user } = await signInWithEmailAndPassword(clientAuth, 'ada@example.com', 'secret-pw');
    const decoded = await getAuth(initializeApp({ sandbox })).verifyIdToken(await user.getIdToken());
    expect(decoded.uid).toBe(user.uid);
    expect(decoded.email).toBe('ada@example.com');
    expect(decoded.email_verified).toBe(true);
    expect(decoded.firebase).toEqual({ identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' });
  });

  it('setCustomUserClaims refuses reserved claim names with auth/reserved-claim', async () => {
    const auth = getAuth(initializeApp({ sandbox: initializeSandbox() }));
    const user = await auth.createUser({ email: 'ada@example.com' });
    await expect(auth.setCustomUserClaims(user.uid, { sub: 'x' })).rejects.toMatchObject({
      code: 'auth/reserved-claim',
      message: 'Developer claim "sub" is reserved and cannot be specified.',
    });
    await expect(auth.setCustomUserClaims(user.uid, { firebase: {}, iat: 1 })).rejects.toMatchObject({
      code: 'auth/reserved-claim',
      message: 'Developer claims "iat", "firebase" are reserved and cannot be specified.',
    });
    await expect(auth.setCustomUserClaims(user.uid, { name: 'allowed' })).resolves.toBeUndefined();
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

  it('claims read off the UserRecord reach verifyIdToken through the ID token a custom-token sign-in gets', async () => {
    // As in production, a custom token is exchanged for an ID token first,
    // and only the ID token verifies (#1949). The caller's pattern: read
    // claims off the UserRecord, put them in the custom token, sign in.
    const { getAuth: getClientAuth, signInWithCustomToken } = await import('pyric/auth');
    const sandbox = initializeSandbox();
    const auth = getAuth(initializeApp({ sandbox }));
    await auth.createUser({ uid: 'alice' });
    await auth.setCustomUserClaims('alice', { role: 'admin' });
    const stored = await auth.getUser('alice');
    const customToken = await auth.createCustomToken(stored.uid, stored.customClaims ?? {});
    await expect(auth.verifyIdToken(customToken)).rejects.toMatchObject({ code: 'auth/argument-error' });
    const { user } = await signInWithCustomToken(getClientAuth(sandbox), customToken);
    const decoded = await auth.verifyIdToken(await user.getIdToken());
    expect(decoded.uid).toBe('alice');
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

