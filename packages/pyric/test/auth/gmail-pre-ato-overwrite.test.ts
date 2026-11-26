/**
 * Adversarial regression tests for `@gmail.com` Google sign-in pre-account-takeover
 * overwrite semantics across staged results, custom resolvers, `signInWithRedirect`,
 * `beforeSignIn` blocking hooks, refresh-token revocation, and case-insensitive
 * `@GMAIL.COM` addresses (Refs #1814).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { authAccountsFor, getClock } from 'pyric/sandbox/internal';
import {
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  sandbox as authSandbox,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type AuthFlowResolver,
  type User,
} from '../../src/auth/index.js';
import { setAuthBlockingHooks } from '../../src/auth/internal.js';
import type { Sandbox } from '../../src/sandbox/index.js';

function setupAuth(sandbox: Sandbox): Auth {
  const auth = getAuth(sandbox);
  authSandbox.setAuthProviderConfig(auth, 'google.com', true);
  authSandbox.setAuthProviderConfig(auth, 'github.com', true);
  return auth;
}

function stagedGoogleUser(uid: string, email: string, emailVerified: boolean): User {
  const now = new Date().toISOString();
  return {
    uid,
    email,
    displayName: null,
    photoURL: null,
    isAnonymous: false,
    emailVerified,
    getIdToken: async () => 'staged-token',
    getIdTokenResult: async () => ({
      token: 'staged-token',
      claims: {},
      expirationTime: now,
      issuedAtTime: now,
      authTime: now,
    }),
  };
}

function providersOf(auth: Auth, uid: string): string[] | undefined {
  return authSandbox
    .listUsers(auth)
    .find((record) => record.uid === uid)
    ?.providerUserInfo.map((entry) => entry.providerId);
}

describe('@gmail.com Google pre-ATO overwrite across all in-page sign-in planes (Refs #1814)', () => {
  it('overwrites an unverified @gmail.com password + GitHub account on staged mockSignInResult popup and revokes attacker refresh tokens', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 2, 1, 12, 0, 0));
    const auth = setupAuth(sandbox);
    const victim = 'staged-victim@gmail.com';

    const attackerCred = await createUserWithEmailAndPassword(auth, victim, 'attacker-pw');
    const attackerUser = attackerCred.user;
    const attackerToken = await attackerUser.getIdToken();
    expect(attackerToken.length).toBeGreaterThan(0);
    authSandbox.createSignInCredential(auth, { providerId: 'github.com', uid: attackerUser.uid });

    // Advance past whole-second boundary so revocation invalidates attacker's prior auth_time.
    clock.advance(2000);
    authSandbox.mockSignInResult(auth, {
      user: stagedGoogleUser(attackerUser.uid, victim, true),
      providerId: 'google.com',
      operationType: 'signIn',
    });

    const victimCred = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(victimCred.user.uid).toBe(attackerUser.uid);
    expect(victimCred.user.emailVerified).toBe(true);
    expect(auth.currentUser?.emailVerified).toBe(true);
    expect((await victimCred.user.getIdTokenResult()).claims.email_verified).toBe(true);
    expect(providersOf(auth, attackerUser.uid)).toEqual(['google.com']);
    expect((victimCred.user.providerData ?? []).map((p) => p.providerId)).toEqual(['google.com']);

    // Prior refresh tokens were revoked on credential stripping.
    const standing = authAccountsFor(sandbox)?.standing(attackerUser.uid);
    expect(standing).toEqual({ kind: 'active', tokensValidAfterMs: Date.UTC(2026, 2, 1, 12, 0, 2) });
    await expect(attackerUser.getIdToken(true)).rejects.toMatchObject({
      code: 'auth/user-token-expired',
    });

    // Attacker's password no longer signs in.
    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, victim, 'attacker-pw')).rejects.toMatchObject({
      code: 'auth/invalid-credential',
    });
  });

  it('overwrites an unverified @gmail.com password account on staged mockSignInResult signInWithCredential', async () => {
    const sandbox = initializeSandbox();
    const auth = setupAuth(sandbox);
    const victim = 'cred-staged-victim@gmail.com';

    const created = await createUserWithEmailAndPassword(auth, victim, 'attacker-pw');
    await signOut(auth);

    authSandbox.mockSignInResult(auth, {
      user: stagedGoogleUser(created.user.uid, victim, true),
      providerId: 'google.com',
      operationType: 'signIn',
    });

    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential('staged-google-id-token'),
    );
    expect(result.user.uid).toBe(created.user.uid);
    expect(result.user.emailVerified).toBe(true);
    expect(providersOf(auth, created.user.uid)).toEqual(['google.com']);
    expect((result.user.providerData ?? []).map((p) => p.providerId)).toEqual(['google.com']);
    expect((await result.user.getIdTokenResult()).claims.email_verified).toBe(true);

    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, victim, 'attacker-pw')).rejects.toMatchObject({
      code: 'auth/invalid-credential',
    });
  });

  it('overwrites an unverified @gmail.com account when beforeSignIn blocking hook approves, and skips overwrite when it rejects', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 2, 1, 13, 0, 0));
    const auth = setupAuth(sandbox);
    const victim = 'blocked-victim@gmail.com';

    const created = await createUserWithEmailAndPassword(auth, victim, 'attacker-pw');
    authSandbox.createSignInCredential(auth, { providerId: 'github.com', uid: created.user.uid });
    await signOut(auth);

    const resolver: AuthFlowResolver = {
      openPopup: async () => ({
        user: stagedGoogleUser(created.user.uid, victim, true),
        providerId: 'google.com',
        operationType: 'signIn',
      }),
      openRedirect: async () => ({
        user: stagedGoogleUser(created.user.uid, victim, true),
        providerId: 'google.com',
        operationType: 'signIn',
      }),
    };
    authSandbox.setAuthFlowResolver(auth, resolver);

    // 1. Rejected beforeSignIn leaves password and unverified state intact.
    setAuthBlockingHooks(auth, {
      beforeSignIn: () => {
        const err = new Error('blocked') as Error & { code: string };
        err.code = 'permission-denied';
        throw err;
      },
    });
    await expect(signInWithPopup(auth, new GoogleAuthProvider())).rejects.toThrow(/blocked/);
    expect(providersOf(auth, created.user.uid)).toEqual(['password', 'github.com']);
    setAuthBlockingHooks(auth, null);
    const stillPassword = await signInWithEmailAndPassword(auth, victim, 'attacker-pw');
    expect(stillPassword.user.emailVerified).toBe(false);
    await signOut(auth);

    // 2. Approved beforeSignIn runs @gmail.com overwrite and strips password + GitHub.
    clock.advance(2000);
    setAuthBlockingHooks(auth, {
      beforeSignIn: () => ({ sessionClaims: { gate: 'passed' } }),
    });
    const approved = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(approved.user.uid).toBe(created.user.uid);
    expect(approved.user.emailVerified).toBe(true);
    expect(providersOf(auth, created.user.uid)).toEqual(['google.com']);
    const token = await approved.user.getIdTokenResult();
    expect(token.claims.email_verified).toBe(true);
    expect(token.claims.gate).toBe('passed');

    setAuthBlockingHooks(auth, null);
    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, victim, 'attacker-pw')).rejects.toMatchObject({
      code: 'auth/invalid-credential',
    });
  });

  it('handles case-insensitive @GMAIL.COM over signInWithRedirect and preserves verified or non-gmail accounts', async () => {
    const sandbox = initializeSandbox();
    const auth = setupAuth(sandbox);
    const upperVictim = 'Upper.Victim@GMAIL.COM';

    const created = await createUserWithEmailAndPassword(auth, upperVictim, 'attacker-pw');
    await signOut(auth);
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async () => {
        throw new Error('unused');
      },
      openRedirect: async () =>
        authSandbox.createSignInCredential(auth, {
          providerId: 'google.com',
          spec: { email: upperVictim },
        }),
    });

    await signInWithRedirect(auth, new GoogleAuthProvider());
    const redirectCred = await getRedirectResult(auth);
    expect(redirectCred?.user.uid).toBe(created.user.uid);
    expect(redirectCred?.user.emailVerified).toBe(true);
    expect(providersOf(auth, created.user.uid)).toEqual(['google.com']);

    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, upperVictim, 'attacker-pw')).rejects.toMatchObject({
      code: 'auth/invalid-credential',
    });
    authSandbox.setAuthFlowResolver(auth, null);

    // Verified @gmail.com keeps password on staged Google sign-in.
    const verifiedGmail = 'verified-staged@gmail.com';
    const verifiedCreated = await createUserWithEmailAndPassword(auth, verifiedGmail, 'owner-pw');
    authSandbox.updateUser(auth, verifiedCreated.user.uid, { emailVerified: true });
    await signOut(auth);
    authSandbox.mockSignInResult(auth, {
      user: stagedGoogleUser(verifiedCreated.user.uid, verifiedGmail, true),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    await signInWithPopup(auth, new GoogleAuthProvider());
    expect(providersOf(auth, verifiedCreated.user.uid)).toEqual(['password', 'google.com']);
    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, verifiedGmail, 'owner-pw')).resolves.toBeDefined();
    await signOut(auth);

    // Look-alike domains are NOT treated as @gmail.com.
    for (const lookalike of ['a@notgmail.com', 'a@gmail.com.evil.example']) {
      const nonGmail = await createUserWithEmailAndPassword(auth, lookalike, 'keep-pw');
      await signOut(auth);
      authSandbox.mockSignInResult(auth, {
        user: stagedGoogleUser(nonGmail.user.uid, lookalike, true),
        providerId: 'google.com',
        operationType: 'signIn',
      });
      await signInWithPopup(auth, new GoogleAuthProvider());
      expect(providersOf(auth, nonGmail.user.uid)).toEqual(['password', 'google.com']);
      await signOut(auth);
      await expect(signInWithEmailAndPassword(auth, lookalike, 'keep-pw')).resolves.toBeDefined();
      await signOut(auth);
    }

    // Explicit staged emailVerified: false keeps the caller flag on @gmail.com.
    const keepFlagEmail = 'explicit-unverified@gmail.com';
    const keepFlag = await createUserWithEmailAndPassword(auth, keepFlagEmail, 'keep-pw');
    await signOut(auth);
    authSandbox.mockSignInResult(auth, {
      user: stagedGoogleUser(keepFlag.user.uid, keepFlagEmail, false),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const stagedFalse = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(stagedFalse.user.emailVerified).toBe(false);
    expect(providersOf(auth, keepFlag.user.uid)).toEqual(['password', 'google.com']);
  });
});
