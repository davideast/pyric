/**
 * Pluggable popup/redirect resolver (the sign-in-helper seam) — sandbox
 * target. Covers the `_withDefaultResolver`-style precedence (per-call →
 * injected → one-shot mock → `auth/argument-error`), cancel propagation,
 * the redirect round-trip via `getRedirectResult`, and `listIdentities`.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  type AuthFlowResolver,
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

function fixedResolver(uid: string): AuthFlowResolver {
  const cred = (): UserCredential => ({
    user: makeFakeUser(uid, `${uid}@example.com`),
    providerId: 'google.com',
    operationType: 'signIn',
  });
  return { openPopup: async () => cred(), openRedirect: async () => cred() };
}

describe('AuthFlowResolver (sandbox)', () => {
  it('no resolver + no mock → throws auth/argument-error (faithful default)', async () => {
    const auth = getAuth(initializeSandbox());
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/argument-error');
    }
  });

  it('one-shot mock is used when no resolver is injected (headless path)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('mock-user'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const res = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(res.user.uid).toBe('mock-user');
  });

  it('injected resolver drives the flow + sets currentUser', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthFlowResolver(auth, fixedResolver('resolver-user'));
    const res = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(res.user.uid).toBe('resolver-user');
    expect(auth.currentUser?.uid).toBe('resolver-user');
  });

  it('precedence: injected resolver wins over a staged mock', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('mock-user'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    authSandbox.setAuthFlowResolver(auth, fixedResolver('resolver-user'));
    const res = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(res.user.uid).toBe('resolver-user'); // resolver beats mock
  });

  it('precedence: per-call resolver arg wins over the injected one', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthFlowResolver(auth, fixedResolver('injected'));
    const res = await signInWithPopup(auth, new GoogleAuthProvider(), fixedResolver('per-call'));
    expect(res.user.uid).toBe('per-call');
  });

  it('cancel: resolver rejection (popup-closed-by-user) propagates', async () => {
    const auth = getAuth(initializeSandbox());
    const cancelling: AuthFlowResolver = {
      openPopup: async () => {
        throw Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' });
      },
      openRedirect: async () => {
        throw Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' });
      },
    };
    authSandbox.setAuthFlowResolver(auth, cancelling);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/popup-closed-by-user');
    }
    expect(auth.currentUser).toBeNull(); // no user set on cancel
  });

  it('redirect: signInWithRedirect signs in + getRedirectResult yields the credential once', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthFlowResolver(auth, fixedResolver('redir-user'));
    await signInWithRedirect(auth, new GoogleAuthProvider());
    expect(auth.currentUser?.uid).toBe('redir-user');
    const first = await getRedirectResult(auth);
    expect(first?.user.uid).toBe('redir-user');
    const second = await getRedirectResult(auth);
    expect(second).toBeNull(); // one-shot
  });

  it('getRedirectResult is null when no redirect happened', async () => {
    const auth = getAuth(initializeSandbox());
    expect(await getRedirectResult(auth)).toBeNull();
  });

  it('the no-resolver error names the API that was called (popup vs redirect)', async () => {
    const auth = getAuth(initializeSandbox());
    try {
      await signInWithRedirect(auth, new GoogleAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/argument-error');
      expect((e as Error).message).toContain('signInWithRedirect(');
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('signInWithPopup(');
    }
  });

  it('redirect uses the one-shot mock tier when no resolver is injected', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('redir-mock'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    await signInWithRedirect(auth, new GoogleAuthProvider());
    expect(auth.currentUser?.uid).toBe('redir-mock');
    expect((await getRedirectResult(auth))?.user.uid).toBe('redir-mock');
  });

  it('listIdentities reflects seeded users (account-picker source)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'u1', email: 'a@example.com', password: 'pw123456', customClaims: { admin: true } },
    ]);
    const ids = authSandbox.listIdentities(auth);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.uid).toBe('u1');
    expect(ids[0]!.customClaims).toEqual({ admin: true });
  });
});
