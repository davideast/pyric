/**
 * Track A (agent-capability epic) — provider tracking (A1),
 * backend-owned credentials (A2), and the user-admin surface (A3).
 *
 * Covers: provider recorded per sign-in flow; `signInProvider` on
 * `IdTokenResult` (+ the synthesized `firebase.sign_in_provider`
 * claim); `createSignInCredential` pick/add shapes; CRUD round-trips;
 * `disabled` blocking sign-in with `auth/user-disabled`;
 * `subscribeUsers` firing on every user-DB mutation.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  type Auth,
  type User,
} from '../../src/auth/index.js';
import { TARGET_SYMBOL } from '../../src/auth/types.js';

function freshAuth(): Auth {
  return getAuth(initializeSandbox());
}

function mockUser(uid: string, email: string | null = null): User {
  return {
    uid,
    email,
    displayName: null,
    isAnonymous: false,
    getIdToken: async () => 'tok',
    getIdTokenResult: async () => ({
      token: 'tok',
      claims: {},
      expirationTime: new Date().toISOString(),
      issuedAtTime: new Date().toISOString(),
      authTime: new Date().toISOString(),
    }),
  };
}

function expectAuthError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code} throw`);
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
  }
}

// ─── A1: provider tracking ────────────────────────────────────────────

describe('provider tracking (A1)', () => {
  it('seeded users default to the password provider', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@x.com', password: 'pw1234' },
    ]);
    const [id] = authSandbox.listIdentities(auth);
    expect(id!.providerId).toBe('password');
    expect(id!.providerUserInfo).toEqual([{ providerId: 'password' }]);
  });

  it('seeded users can carry an explicit provider', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'g1', email: 'g@x.com', password: 'pw1234', providerId: 'google.com' },
    ]);
    const [id] = authSandbox.listIdentities(auth);
    expect(id!.providerId).toBe('google.com');
  });

  it('createUserWithEmailAndPassword records the password provider', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'new@x.com', 'pw1234');
    const id = authSandbox.listIdentities(auth).find((i) => i.email === 'new@x.com');
    expect(id!.providerUserInfo).toEqual([{ providerId: 'password' }]);
  });

  it('anonymous users appear in listIdentities with the anonymous label and empty providerUserInfo', async () => {
    const auth = freshAuth();
    const { user } = await signInAnonymously(auth);
    const id = authSandbox.listIdentities(auth).find((i) => i.uid === user.uid);
    expect(id).toBeDefined();
    expect(id!.isAnonymous).toBe(true);
    expect(id!.providerId).toBe('anonymous');
    expect(id!.providerUserInfo).toEqual([]);
  });

  it('popup sign-in upserts an unknown identity with the real provider', async () => {
    const auth = freshAuth();
    authSandbox.mockSignInResult(auth, {
      user: mockUser('popup-1', 'popup@x.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    await signInWithPopup(auth, new GoogleAuthProvider());
    const id = authSandbox.listIdentities(auth).find((i) => i.uid === 'popup-1');
    expect(id!.providerId).toBe('google.com');
    expect(id!.providerUserInfo).toEqual([{ providerId: 'google.com' }]);
  });

  it('popup sign-in for a known identity links the provider without duplicating it', async () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@x.com', password: 'pw1234' },
    ]);
    for (let i = 0; i < 2; i++) {
      authSandbox.mockSignInResult(auth, {
        user: mockUser('alice', 'alice@x.com'),
        providerId: 'google.com',
        operationType: 'signIn',
      });
      await signInWithPopup(auth, new GoogleAuthProvider());
    }
    const id = authSandbox.listIdentities(auth).find((i) => i.uid === 'alice');
    expect(id!.providerUserInfo).toEqual([
      { providerId: 'password' },
      { providerId: 'google.com' },
    ]);
  });
});

describe('IdTokenResult.signInProvider (A1)', () => {
  it('is "anonymous" after anonymous sign-in', async () => {
    const auth = freshAuth();
    const { user } = await signInAnonymously(auth);
    const result = await user.getIdTokenResult();
    expect(result.signInProvider).toBe('anonymous');
    expect((result.claims.firebase as { sign_in_provider: string }).sign_in_provider)
      .toBe('anonymous');
  });

  it('is "password" after email/password sign-in', async () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@x.com', password: 'pw1234' },
    ]);
    const { user } = await signInWithEmailAndPassword(auth, 'alice@x.com', 'pw1234');
    const result = await user.getIdTokenResult();
    expect(result.signInProvider).toBe('password');
  });

  it('is the provider id after a popup sign-in (via createSignInCredential)', async () => {
    const auth = freshAuth();
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'g@x.com', displayName: 'G' },
    });
    authSandbox.mockSignInResult(auth, cred);
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    const result = await user.getIdTokenResult();
    expect(result.signInProvider).toBe('google.com');
    expect((result.claims.firebase as { sign_in_provider: string }).sign_in_provider)
      .toBe('google.com');
  });

  it('custom claims cannot shadow the reserved firebase claim', async () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      {
        uid: 'evil',
        email: 'evil@x.com',
        password: 'pw1234',
        customClaims: { firebase: { sign_in_provider: 'spoofed' } },
      },
    ]);
    const { user } = await signInWithEmailAndPassword(auth, 'evil@x.com', 'pw1234');
    const result = await user.getIdTokenResult();
    expect((result.claims.firebase as { sign_in_provider: string }).sign_in_provider)
      .toBe('password');
  });
});

// ─── A2: backend-owned credentials ────────────────────────────────────

describe('sandbox.createSignInCredential (A2)', () => {
  it('{uid} mints a credential for an existing identity with a backend-owned token', async () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@x.com', password: 'pw1234', customClaims: { role: 'admin' } },
    ]);
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      uid: 'alice',
    });
    expect(cred.providerId).toBe('google.com');
    expect(cred.operationType).toBe('signIn');
    expect(cred.user.uid).toBe('alice');
    expect(cred.user.email).toBe('alice@x.com');
    const token = await cred.user.getIdToken();
    expect(token.startsWith('sandbox-id-token-alice-')).toBe(true);
    const result = await cred.user.getIdTokenResult();
    expect(result.claims.role).toBe('admin');
  });

  it('{uid} throws auth/user-not-found for unknown uids', () => {
    const auth = freshAuth();
    expectAuthError(
      () => authSandbox.createSignInCredential(auth, { providerId: 'google.com', uid: 'ghost' }),
      'auth/user-not-found',
    );
  });

  it('{spec} creates the identity with the default uid and no password', () => {
    const auth = freshAuth();
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'new@x.com', displayName: 'New', customClaims: { plan: 'pro' } },
    });
    expect(cred.user.uid).toBe('google.com:new@x.com');
    const id = authSandbox.listIdentities(auth).find((i) => i.uid === cred.user.uid);
    expect(id!.providerUserInfo).toEqual([{ providerId: 'google.com' }]);
    expect(id!.customClaims).toEqual({ plan: 'pro' });
  });

  it('provider identities cannot sign in via email/password', async () => {
    const auth = freshAuth();
    authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'oauth@x.com' },
    });
    expect(signInWithEmailAndPassword(auth, 'oauth@x.com', 'whatever'))
      .rejects.toMatchObject({ code: 'auth/wrong-password' });
  });

  it('{spec} with an existing email reuses that identity', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@x.com', password: 'pw1234' },
    ]);
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'alice@x.com', displayName: 'Ignored' },
    });
    expect(cred.user.uid).toBe('alice');
    const id = authSandbox.listIdentities(auth).find((i) => i.uid === 'alice');
    expect(id!.providerUserInfo).toEqual([
      { providerId: 'password' },
      { providerId: 'google.com' },
    ]);
  });

  it('resolves a full popup flow: credential → signInWithPopup → signed in', async () => {
    const auth = freshAuth();
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'flow@x.com' },
    });
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async () => cred,
      openRedirect: async () => cred,
    });
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(result.user.uid).toBe('google.com:flow@x.com');
    expect(auth.currentUser?.uid).toBe('google.com:flow@x.com');
  });

  it('throws failed-precondition on prod handles', () => {
    const auth = {
      currentUser: null,
      [TARGET_SYMBOL]: { kind: 'prod', auth: {} as never },
    } as Auth;
    try {
      authSandbox.createSignInCredential(auth, { providerId: 'google.com', uid: 'x' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).code).toBe('failed-precondition');
    }
  });
});

// ─── A3: user-admin CRUD ──────────────────────────────────────────────

describe('sandbox.listUsers / createUser (A3)', () => {
  it('createUser round-trips through listUsers without signing in', () => {
    const auth = freshAuth();
    const record = authSandbox.createUser(auth, {
      uid: 'admin-made',
      email: 'made@x.com',
      password: 'pw1234',
      displayName: 'Made',
      customClaims: { role: 'editor' },
      emailVerified: true,
    });
    expect(record.uid).toBe('admin-made');
    expect(record.emailVerified).toBe(true);
    expect(record.disabled).toBe(false);
    expect(record.providerUserInfo).toEqual([{ providerId: 'password' }]);
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.lastLoginAt).toBe(null);
    expect(auth.currentUser).toBe(null); // admin create ≠ sign-in
    const listed = authSandbox.listUsers(auth).find((u) => u.uid === 'admin-made');
    expect(listed).toEqual(record);
  });

  it('generates a uid when none is given', () => {
    const auth = freshAuth();
    const record = authSandbox.createUser(auth, {});
    expect(record.uid).toMatch(/^user-\d+$/);
  });

  it('rejects duplicate uid, duplicate email, weak password, bad email, password-without-email', () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    expectAuthError(
      () => authSandbox.createUser(auth, { uid: 'u1' }),
      'auth/uid-already-exists',
    );
    expectAuthError(
      () => authSandbox.createUser(auth, { email: 'u1@x.com' }),
      'auth/email-already-in-use',
    );
    expectAuthError(
      () => authSandbox.createUser(auth, { email: 'w@x.com', password: 'pw' }),
      'auth/weak-password',
    );
    expectAuthError(
      () => authSandbox.createUser(auth, { email: 'not-an-email' }),
      'auth/invalid-email',
    );
    expectAuthError(
      () => authSandbox.createUser(auth, { password: 'pw1234' }),
      'auth/invalid-email',
    );
  });

  it('lastLoginAt is bumped by an actual sign-in', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    await signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234');
    const record = authSandbox.listUsers(auth).find((u) => u.uid === 'u1');
    expect(record!.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('sandbox.updateUser (A3)', () => {
  it('updates displayName (incl. null-clear), emailVerified, customClaims', () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', displayName: 'Before' });
    let r = authSandbox.updateUser(auth, 'u1', {
      displayName: 'After',
      emailVerified: true,
      customClaims: { role: 'admin' },
    });
    expect(r.displayName).toBe('After');
    expect(r.emailVerified).toBe(true);
    expect(r.customClaims).toEqual({ role: 'admin' });
    r = authSandbox.updateUser(auth, 'u1', { displayName: null, customClaims: {} });
    expect(r.displayName).toBe(null);
    expect(r.customClaims).toEqual({}); // wholesale replace, not merge
  });

  it('re-keys the email index — sign-in works with the new email only', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'old@x.com', password: 'pw1234' });
    authSandbox.updateUser(auth, 'u1', { email: 'new@x.com' });
    const { user } = await signInWithEmailAndPassword(auth, 'new@x.com', 'pw1234');
    expect(user.uid).toBe('u1');
    expect(signInWithEmailAndPassword(auth, 'old@x.com', 'pw1234'))
      .rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('rejects an email update that collides with another account', () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com' });
    authSandbox.createUser(auth, { uid: 'u2', email: 'u2@x.com' });
    expectAuthError(
      () => authSandbox.updateUser(auth, 'u2', { email: 'u1@x.com' }),
      'auth/email-already-in-use',
    );
  });

  it('setting a password links the password provider and enables sign-in', async () => {
    const auth = freshAuth();
    const cred = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'oauth@x.com' },
    });
    authSandbox.updateUser(auth, cred.user.uid, { password: 'pw1234' });
    const record = authSandbox.listUsers(auth).find((u) => u.uid === cred.user.uid);
    expect(record!.providerUserInfo).toEqual([
      { providerId: 'google.com' },
      { providerId: 'password' },
    ]);
    const { user } = await signInWithEmailAndPassword(auth, 'oauth@x.com', 'pw1234');
    expect(user.uid).toBe(cred.user.uid);
  });

  it('claims changes reach the next forced token refresh (live claims)', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    const { user } = await signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234');
    expect((await user.getIdTokenResult()).claims.role).toBeUndefined();
    authSandbox.updateUser(auth, 'u1', { customClaims: { role: 'admin' } });
    const refreshed = await user.getIdTokenResult(true);
    expect(refreshed.claims.role).toBe('admin');
  });

  it('throws auth/user-not-found for unknown uids', () => {
    const auth = freshAuth();
    expectAuthError(
      () => authSandbox.updateUser(auth, 'ghost', { displayName: 'x' }),
      'auth/user-not-found',
    );
  });
});

describe('sandbox.deleteUser / clearUsers (A3)', () => {
  it('deleteUser removes the record; subsequent sign-in is user-not-found', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    authSandbox.deleteUser(auth, 'u1');
    expect(authSandbox.listUsers(auth)).toEqual([]);
    expect(signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234'))
      .rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('deleteUser throws auth/user-not-found for unknown uids', () => {
    const auth = freshAuth();
    expectAuthError(() => authSandbox.deleteUser(auth, 'ghost'), 'auth/user-not-found');
  });

  it('clearUsers drops every record but keeps the active session', async () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'a', email: 'a@x.com', password: 'pw1234' },
      { uid: 'b', email: 'b@x.com', password: 'pw1234' },
    ]);
    await signInWithEmailAndPassword(auth, 'a@x.com', 'pw1234');
    authSandbox.clearUsers(auth);
    expect(authSandbox.listUsers(auth)).toEqual([]);
    expect(auth.currentUser?.uid).toBe('a'); // session not terminated
  });
});

// ─── A3: disabled blocks sign-in ──────────────────────────────────────

describe('disabled users (A3)', () => {
  it('blocks email/password sign-in with auth/user-disabled', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, {
      uid: 'u1', email: 'u1@x.com', password: 'pw1234', disabled: true,
    });
    expect(signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234'))
      .rejects.toMatchObject({ code: 'auth/user-disabled' });
  });

  it('blocks popup sign-in with auth/user-disabled', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'popup-1', email: 'p@x.com', disabled: true });
    authSandbox.mockSignInResult(auth, {
      user: mockUser('popup-1', 'p@x.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    expect(signInWithPopup(auth, new GoogleAuthProvider()))
      .rejects.toMatchObject({ code: 'auth/user-disabled' });
    expect(auth.currentUser).toBe(null);
  });

  it('re-enabling restores sign-in', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, {
      uid: 'u1', email: 'u1@x.com', password: 'pw1234', disabled: true,
    });
    authSandbox.updateUser(auth, 'u1', { disabled: false });
    const { user } = await signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234');
    expect(user.uid).toBe('u1');
  });

  it('disabling does not terminate the active session (prod parity)', async () => {
    const auth = freshAuth();
    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    await signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234');
    authSandbox.updateUser(auth, 'u1', { disabled: true });
    expect(auth.currentUser?.uid).toBe('u1');
  });
});

// ─── A3: subscribeUsers ───────────────────────────────────────────────

describe('sandbox.subscribeUsers (A3)', () => {
  it('fires on seed, create, update, delete, and clear', () => {
    const auth = freshAuth();
    let fires = 0;
    authSandbox.subscribeUsers(auth, () => { fires++; });
    expect(fires).toBe(0); // no initial fire — coarse contract

    authSandbox.seedUsers(auth, [{ uid: 'a', email: 'a@x.com', password: 'pw1234' }]);
    expect(fires).toBe(1);
    authSandbox.createUser(auth, { uid: 'b' });
    expect(fires).toBe(2);
    authSandbox.updateUser(auth, 'b', { displayName: 'B' });
    expect(fires).toBe(3);
    authSandbox.deleteUser(auth, 'b');
    expect(fires).toBe(4);
    authSandbox.clearUsers(auth);
    expect(fires).toBe(5);
  });

  it('fires on sign-in driven mutations (anonymous mint, lastLoginAt bump)', async () => {
    const auth = freshAuth();
    let fires = 0;
    authSandbox.subscribeUsers(auth, () => { fires++; });
    await signInAnonymously(auth); // mint + lastLoginAt bump
    expect(fires).toBeGreaterThanOrEqual(1);
  });

  it('unsubscribe stops fires; throwing listeners are isolated', () => {
    const auth = freshAuth();
    let a = 0;
    let b = 0;
    authSandbox.subscribeUsers(auth, () => { a++; throw new Error('boom'); });
    const unsubB = authSandbox.subscribeUsers(auth, () => { b++; });
    authSandbox.createUser(auth, { uid: 'u1' });
    expect(a).toBe(1);
    expect(b).toBe(1); // thrower didn't block
    unsubB();
    authSandbox.createUser(auth, { uid: 'u2' });
    expect(a).toBe(2);
    expect(b).toBe(1);
  });

  it('throws failed-precondition on prod handles', () => {
    const auth = {
      currentUser: null,
      [TARGET_SYMBOL]: { kind: 'prod', auth: {} as never },
    } as Auth;
    try {
      authSandbox.listUsers(auth);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SandboxError).code).toBe('failed-precondition');
    }
  });
});
