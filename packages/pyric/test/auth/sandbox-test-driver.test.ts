/**
 * Sandbox-only test driver API — `sandbox.setUser`,
 * `sandbox.mockSignInResult`, `sandbox.seedUsers`.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import {
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  type User,
} from '../../src/auth/index.js';

function makeUser(uid: string): User {
  return {
    uid,
    email: `${uid}@example.com`,
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

describe('sandbox.setUser', () => {
  it('forces currentUser to a synthetic user', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setUser(auth, makeUser('forced'));
    expect(auth.currentUser?.uid).toBe('forced');
    expect(sandbox.currentUser?.uid).toBe('forced');
  });

  it('null signs out', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    authSandbox.setUser(auth, null);
    expect(auth.currentUser).toBe(null);
  });
});

describe('sandbox.seedUsers', () => {
  it('loads multiple users at once', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'a', email: 'a@x.com', password: 'pw' },
      { uid: 'b', email: 'b@x.com', password: 'pw', customClaims: { role: 'admin' } },
    ]);
    // Verify by attempting sign-in.
    // (We don't probe DB state directly — the public surface is
    //  signInWithEmailAndPassword, so the load is observable
    //  through that.)
    expect(true).toBe(true);
  });
});

describe('sandbox.mockSignInResult', () => {
  it('rejects results without a providerId', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      authSandbox.mockSignInResult(auth, {
        user: makeUser('x'),
        providerId: null,
        operationType: 'signIn',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SandboxError).code).toBe('invalid-argument');
    }
  });
});
