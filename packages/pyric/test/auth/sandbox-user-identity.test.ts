/**
 * Rich-`User` preservation across identity transitions — sandbox target.
 *
 * Locks AUTH-B1: a popup/redirect/credential/setUser sign-in must NOT
 * clobber the rich `User` the caller handed in. Before the fix, the
 * synchronous `sandbox.onCurrentUserChanged` subscriber rebuilt
 * `cachedUser` from the bare `AuthState` (uid + claims only) — losing
 * `email` / `displayName` for any user not in the email/password DB, and
 * minting a fresh object so `cred.user === auth.currentUser` failed.
 *
 * Upstream: `core/strategies/anonymous.ts:60-68` (and every sign-in
 * strategy) calls `_updateCurrentUser(userCredential.user)` so the
 * credential's `user` IS `auth.currentUser` — same fields, same reference.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  type AuthFlowResolver,
  type User,
  type UserCredential,
} from '../../src/auth/index.js';

function makeRichUser(uid: string): User {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName: `Display ${uid}`,
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

function richResolver(uid: string): AuthFlowResolver {
  const cred = (): UserCredential => ({
    user: makeRichUser(uid),
    providerId: 'google.com',
    operationType: 'signIn',
  });
  return { openPopup: async () => cred(), openRedirect: async () => cred() };
}

describe('rich User preservation (sandbox)', () => {
  it('signInWithPopup keeps email + displayName on currentUser', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAuthFlowResolver(auth, richResolver('google-123'));
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user.email).toBe('google-123@example.com');
    expect(cred.user.displayName).toBe('Display google-123');
    expect(auth.currentUser?.email).toBe('google-123@example.com');
    expect(auth.currentUser?.displayName).toBe('Display google-123');
    expect(auth.currentUser?.isAnonymous).toBe(false);
  });

  it('signInWithPopup: cred.user === auth.currentUser (reference identity)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAuthFlowResolver(auth, richResolver('google-456'));
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user).toBe(auth.currentUser!);
  });

  it('signInWithCredential keeps the rich user + reference identity', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeRichUser('cred-user'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const cred = await signInWithCredential(auth, {
      providerId: 'google.com',
      signInMethod: 'google.com',
    });
    expect(cred.user.email).toBe('cred-user@example.com');
    expect(cred.user.displayName).toBe('Display cred-user');
    expect(cred.user).toBe(auth.currentUser!);
  });

  it('signInWithRedirect keeps the rich user; getRedirectResult agrees', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAuthFlowResolver(auth, richResolver('redir-rich'));
    await signInWithRedirect(auth, new GoogleAuthProvider());
    expect(auth.currentUser?.email).toBe('redir-rich@example.com');
    expect(auth.currentUser?.displayName).toBe('Display redir-rich');
    const result = await getRedirectResult(auth);
    expect(result?.user).toBe(auth.currentUser!);
  });

  it('sandbox.setUser keeps the rich user + reference identity', async () => {
    const auth = getAuth(initializeSandbox());
    const user = makeRichUser('manual');
    authSandbox.setUser(auth, user);
    expect(auth.currentUser).toBe(user);
    expect(auth.currentUser?.email).toBe('manual@example.com');
    expect(auth.currentUser?.displayName).toBe('Display manual');
  });

  it('bare resolver without providerData: popup patches google.com onto currentUser', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAuthFlowResolver(auth, richResolver('bare-google'));
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(cred.user).toBe(auth.currentUser!);
    expect(cred.user.providerData?.map((p) => p.providerId)).toContain('google.com');
    expect(cred.user.providerId).toBe('firebase');
    expect((await cred.user.getIdTokenResult()).signInProvider).toBe('google.com');
  });
});
