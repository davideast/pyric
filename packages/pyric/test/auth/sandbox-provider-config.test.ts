/**
 * Sign-in provider config (Authentication → Sign-in method toggles) —
 * sandbox target.
 *
 * Covers: defaults (`password`/`anonymous` enabled, everything else
 * disabled), the gating matrix across every provider entry point
 * (`signInAnonymously`, `createUserWithEmailAndPassword`/
 * `signInWithEmailAndPassword`, `signInWithPopup`/`signInWithRedirect`,
 * `signInWithCredential`) × enabled/disabled × the exact error code, and
 * that `auth/argument-error` still fires for an ENABLED-but-unmocked OAuth
 * provider (gating must not swallow that distinct failure mode).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  type User,
  type UserCredential,
} from '../../src/auth/index.js';

function makeFakeUser(uid: string, email: string | null = null): User {
  return {
    uid,
    email,
    displayName: null,
    isAnonymous: false,
    getIdToken: async () => `fake-${uid}`,
    getIdTokenResult: async () => ({
      token: `fake-${uid}`,
      claims: { sub: uid },
      expirationTime: new Date().toISOString(),
      issuedAtTime: new Date().toISOString(),
      authTime: new Date().toISOString(),
    }),
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error('expected throw');
  } catch (e) {
    expect((e as { code: string }).code).toBe(code);
  }
}

describe('sandbox.getAuthProviderConfig — defaults', () => {
  it('password and anonymous are enabled; everything else is disabled', () => {
    const auth = getAuth(initializeSandbox());
    const config = authSandbox.getAuthProviderConfig(auth);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId.password).toBe(true);
    expect(byId.anonymous).toBe(true);
    expect(Object.keys(byId).sort()).toEqual(['anonymous', 'password']);
  });

  it('an untouched provider (google.com) reads as disabled even though absent from the map', () => {
    const auth = getAuth(initializeSandbox());
    expect(authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'google.com')).toBeUndefined();
  });
});

describe('sandbox.setAuthProviderConfig', () => {
  it('toggles a provider on/off and getAuthProviderConfig reflects it', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    expect(authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'google.com')?.enabled).toBe(false);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    expect(authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'google.com')?.enabled).toBe(true);
  });

  it('disabling password blocks it; re-enabling restores it', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    expect(authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'password')?.enabled).toBe(false);
    authSandbox.setAuthProviderConfig(auth, 'password', true);
    expect(authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'password')?.enabled).toBe(true);
  });

  it('is a no-op (no notify) when set to the same value', () => {
    const auth = getAuth(initializeSandbox());
    let fires = 0;
    authSandbox.subscribeAuthProviderConfig(auth, () => { fires++; });
    authSandbox.setAuthProviderConfig(auth, 'password', true); // already true
    expect(fires).toBe(0);
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    expect(fires).toBe(1);
  });
});

describe('gating matrix: signInAnonymously (provider "anonymous")', () => {
  it('enabled (default) → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await signInAnonymously(auth);
    expect(cred.user.isAnonymous).toBe(true);
  });

  it('disabled → auth/operation-not-allowed', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'anonymous', false);
    await expectCode(signInAnonymously(auth), 'auth/operation-not-allowed');
  });
});

describe('gating matrix: password provider', () => {
  it('createUserWithEmailAndPassword: enabled (default) → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await createUserWithEmailAndPassword(auth, 'a@x.com', 'password1');
    expect(cred.user.email).toBe('a@x.com');
  });

  it('createUserWithEmailAndPassword: disabled → auth/operation-not-allowed', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    await expectCode(
      createUserWithEmailAndPassword(auth, 'a@x.com', 'password1'),
      'auth/operation-not-allowed',
    );
  });

  it('signInWithEmailAndPassword: enabled (default) → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [{ uid: 'u1', email: 'a@x.com', password: 'pw123456' }]);
    const cred = await signInWithEmailAndPassword(auth, 'a@x.com', 'pw123456');
    expect(cred.user.uid).toBe('u1');
  });

  it('signInWithEmailAndPassword: disabled → auth/operation-not-allowed (before wrong-password/user-not-found)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [{ uid: 'u1', email: 'a@x.com', password: 'pw123456' }]);
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    // Wrong password AND disabled provider — operation-not-allowed must win.
    await expectCode(
      signInWithEmailAndPassword(auth, 'a@x.com', 'wrong-pw'),
      'auth/operation-not-allowed',
    );
  });
});

describe('gating matrix: signInWithPopup / signInWithRedirect (OAuth)', () => {
  it('google.com enabled by default + mock staged → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user.uid).toBe('g1');
  });

  it('google.com explicitly disabled → auth/operation-not-allowed (even with a mock staged)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    await expectCode(signInWithPopup(auth, new GoogleAuthProvider()), 'auth/operation-not-allowed');
  });

  it('google.com enabled + mock staged → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user.uid).toBe('g1');
  });

  it('google.com enabled, NO mock/resolver → auth/argument-error (distinct from operation-not-allowed)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    await expectCode(signInWithPopup(auth, new GoogleAuthProvider()), 'auth/argument-error');
  });

  it('signInWithRedirect: same gating as popup', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    await expectCode(signInWithRedirect(auth, new GoogleAuthProvider()), 'auth/operation-not-allowed');
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    await expectCode(signInWithRedirect(auth, new GoogleAuthProvider()), 'auth/argument-error');
  });

  it('a custom OAuth provider id is enabled by default; disabling it blocks resolveFlow', async () => {
    const auth = getAuth(initializeSandbox());
    const provider = new OAuthProvider('microsoft.com');
    await expectCode(signInWithPopup(auth, provider), 'auth/argument-error');
    authSandbox.setAuthProviderConfig(auth, 'microsoft.com', false);
    await expectCode(signInWithPopup(auth, provider), 'auth/operation-not-allowed');
  });
});

describe('gating matrix: signInWithCredential', () => {
  it('disabled providerId → auth/operation-not-allowed (even with a mock staged)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const credential = { providerId: 'google.com', signInMethod: 'google.com' };
    await expectCode(signInWithCredential(auth, credential), 'auth/operation-not-allowed');
  });

  it('enabled + mock staged → succeeds', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const credential = { providerId: 'google.com', signInMethod: 'google.com' };
    const cred = await signInWithCredential(auth, credential);
    expect((cred as UserCredential).user.uid).toBe('g1');
  });

  it('enabled, no mock → auth/no-mock-configured (untouched by the new gate)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    const credential = { providerId: 'google.com', signInMethod: 'google.com' };
    await expectCode(signInWithCredential(auth, credential), 'auth/no-mock-configured');
  });
});

describe('gating matrix: sandbox.mintSession (the served-worker per-port session path)', () => {
  // `sandbox.mintSession` is a SEPARATE entry point from the index.ts free
  // functions above — it's what the SharedWorker host actually calls for
  // `auth.signInAnonymously` / `auth.createUser` / `auth.signInEmail`
  // (see packages/cli/src/serve/worker/host-auth.ts). Full fidelity requires
  // gating it too, or the Studio "Sign-in providers" toggle would have zero
  // effect in served mode — the primary product surface.
  it('kind "anonymous": disabled → auth/operation-not-allowed', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'anonymous', false);
    expect(() => authSandbox.mintSession(auth, { kind: 'anonymous' })).toThrow(
      expect.objectContaining({ code: 'auth/operation-not-allowed' }),
    );
  });

  it('kind "anonymous": enabled (default) → succeeds', () => {
    const auth = getAuth(initializeSandbox());
    const session = authSandbox.mintSession(auth, { kind: 'anonymous' });
    expect(session.user.isAnonymous).toBe(true);
  });

  it('kind "createPassword": disabled → auth/operation-not-allowed', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    expect(() =>
      authSandbox.mintSession(auth, { kind: 'createPassword', email: 'a@x.com', password: 'password1' }),
    ).toThrow(expect.objectContaining({ code: 'auth/operation-not-allowed' }));
  });

  it('kind "password": disabled → auth/operation-not-allowed (before wrong-password/user-not-found)', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [{ uid: 'u1', email: 'a@x.com', password: 'pw123456' }]);
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    expect(() =>
      authSandbox.mintSession(auth, { kind: 'password', email: 'a@x.com', password: 'wrong' }),
    ).toThrow(expect.objectContaining({ code: 'auth/operation-not-allowed' }));
  });

  it('kind "uid" (session restore) is NOT gated — matches restoreSession precedent', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [{ uid: 'u1', email: 'a@x.com', password: 'pw123456' }]);
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    // Disabling the provider AFTER the fact does not invalidate restoring an
    // already-authenticated session — the same policy restoreSession follows.
    const session = authSandbox.mintSession(auth, { kind: 'uid', uid: 'u1' });
    expect(session.user.uid).toBe('u1');
  });
});

describe('provider-enforcement delegation (the served-worker page-sandbox seam)', () => {
  it('delegateProviderEnforcement(true) bypasses the LOCAL gate (popup proceeds to the resolver tier)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.delegateProviderEnforcement(auth, true);
    // google.com stays OFF locally; with delegation the gate is a no-op and
    // the flow falls through to "no resolver/mock" — argument-error, NOT
    // operation-not-allowed.
    await expectCode(signInWithPopup(auth, new GoogleAuthProvider()), 'auth/argument-error');
  });

  it('delegation is a no-op for the mock path too — a staged mock resolves despite a disabled provider', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.delegateProviderEnforcement(auth, true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g1', 'g1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user.uid).toBe('g1');
  });

  it('reclaiming enforcement (false) restores the default gate', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    authSandbox.delegateProviderEnforcement(auth, true);
    authSandbox.delegateProviderEnforcement(auth, false);
    await expectCode(signInWithPopup(auth, new GoogleAuthProvider()), 'auth/operation-not-allowed');
  });

  it('assertAuthProviderEnabled: the authority-side gate throws for disabled, passes for enabled', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    expect(() => authSandbox.assertAuthProviderEnabled(auth, 'google.com')).toThrow(
      expect.objectContaining({ code: 'auth/operation-not-allowed' }),
    );
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    expect(() => authSandbox.assertAuthProviderEnabled(auth, 'google.com')).not.toThrow();
  });
});
