/**
 * `sandbox.mockSignInResult` on a served handle: a handle this copy of
 * `pyric/auth` didn't make forwards the result to the hook a served
 * `getAuth` attached under `SERVED_SANDBOX_HOOK` (issue #1466).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithCredential,
  type Auth,
  type User,
  type UserCredential,
} from '../../src/auth/index.js';
import { SERVED_SANDBOX_HOOK, type ServedSandboxHook } from '../../src/auth/internal.js';

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

function googleResult(uid: string): UserCredential {
  return { user: makeUser(uid), providerId: 'google.com', operationType: 'signIn' };
}

function recordingHook(): ServedSandboxHook & { calls: UserCredential[] } {
  const calls: UserCredential[] = [];
  return { calls, mockSignInResult: (result) => calls.push(result) };
}

function attachHook(handle: object, hook: ServedSandboxHook): Auth {
  Object.defineProperty(handle, SERVED_SANDBOX_HOOK, { value: hook });
  return handle as Auth;
}

describe('SERVED_SANDBOX_HOOK', () => {
  it('is the registered symbol a second copy of pyric resolves to', () => {
    expect(SERVED_SANDBOX_HOOK).toBe(Symbol.for('pyric.auth.servedSandbox'));
  });
});

describe('sandbox.mockSignInResult with a served hook', () => {
  it('stages on its own target and ignores a hook on a handle it made', async () => {
    const auth = getAuth(initializeSandbox());
    const hook = recordingHook();
    attachHook(auth, hook);

    authSandbox.mockSignInResult(auth, googleResult('staged-own'));

    expect(hook.calls).toHaveLength(0);
    const signedIn = await signInWithCredential(auth, GoogleAuthProvider.credential('t'));
    expect(signedIn.user.uid).toBe('staged-own');
  });

  it('forwards the result once to the hook on a handle it did not make', () => {
    const hook = recordingHook();
    const served = attachHook({}, hook);
    const result = googleResult('staged-served');

    authSandbox.mockSignInResult(served, result);

    expect(hook.calls).toEqual([result]);
  });

  it('throws the unrecognized-handle error when there is no target and no hook', () => {
    expect(() => authSandbox.mockSignInResult({} as Auth, googleResult('x'))).toThrow(
      'unrecognized Auth handle',
    );
  });

  it('refuses a result without a providerId before the hook runs', () => {
    const hook = recordingHook();
    const served = attachHook({}, hook);
    let code: string | undefined;
    try {
      authSandbox.mockSignInResult(served, {
        user: makeUser('x'),
        providerId: null,
        operationType: 'signIn',
      });
    } catch (e) {
      code = (e as SandboxError).code;
    }
    expect(code).toBe('invalid-argument');
    expect(hook.calls).toHaveLength(0);
  });
});
