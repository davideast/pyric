/**
 * Provider classes + signInWithPopup / signInWithCredential —
 * sandbox target.
 *
 * Covers provider marker shape (`PROVIDER_ID` static fields,
 * instance `providerId`, fluent `addScope` / `setCustomParameters`),
 * the mock-result registry consumed by `signInWithPopup`, the
 * `auth/no-mock-configured` error path, and
 * `credentialFromResult` synthesis.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  EmailAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithCredential,
  signInWithPopup,
  type User,
} from '../../src/auth/index.js';

function makeFakeUser(uid: string, email: string): User {
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

describe('provider markers', () => {
  it('GoogleAuthProvider.PROVIDER_ID is google.com', () => {
    expect(GoogleAuthProvider.PROVIDER_ID).toBe('google.com');
    const p = new GoogleAuthProvider();
    expect(p.providerId).toBe('google.com');
    // Fluent: returns this.
    expect(p.addScope('email')).toBe(p);
    expect(p.setCustomParameters({ prompt: 'consent' })).toBe(p);
  });

  it('EmailAuthProvider.PROVIDER_ID is password', () => {
    expect(EmailAuthProvider.PROVIDER_ID).toBe('password');
  });

  it('FacebookAuthProvider.PROVIDER_ID is facebook.com', () => {
    expect(FacebookAuthProvider.PROVIDER_ID).toBe('facebook.com');
    expect(new FacebookAuthProvider().providerId).toBe('facebook.com');
  });

  it('GithubAuthProvider.PROVIDER_ID is github.com', () => {
    expect(GithubAuthProvider.PROVIDER_ID).toBe('github.com');
    expect(new GithubAuthProvider().providerId).toBe('github.com');
  });

  it('OAuthProvider takes a providerId at construction', () => {
    const p = new OAuthProvider('apple.com');
    expect(p.providerId).toBe('apple.com');
    expect(p.addScope('email')).toBe(p);
  });

  it('credentialFromResult returns a credential with the right providerId', () => {
    const result = {
      user: makeFakeUser('u1', 'u1@example.com'),
      providerId: 'google.com',
      operationType: 'signIn' as const,
    };
    const cred = GoogleAuthProvider.credentialFromResult(result);
    expect(cred).not.toBe(null);
    expect(cred!.providerId).toBe('google.com');
  });

  it('credentialFromError returns null', () => {
    expect(GoogleAuthProvider.credentialFromError(new Error('x'))).toBe(null);
  });

  it('EmailAuthProvider.credential returns a marker', () => {
    const cred = EmailAuthProvider.credential('a@b.com', 'pw');
    expect(cred.providerId).toBe('password');
  });
});

describe('signInWithPopup (sandbox)', () => {
  it('throws auth/argument-error without a pre-staged result', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/argument-error');
      expect((e as Error).message).toContain('sandbox.mockSignInResult');
    }
  });

  it('returns the pre-staged mock result and sets currentUser', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    const mockUser = makeFakeUser('google-user-1', 'a@example.com');
    authSandbox.mockSignInResult(auth, {
      user: mockUser,
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(result.user.uid).toBe('google-user-1');
    expect(auth.currentUser?.uid).toBe('google-user-1');
  });

  it('mock result is one-shot — second call without re-stage throws', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('u', 'u@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    await signInWithPopup(auth, new GoogleAuthProvider());
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/argument-error');
    }
  });

  it('mocks are keyed per provider', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAuthProviderConfig(auth, 'facebook.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('g-user', 'g@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    // FB call should miss its own mock even though google's is staged.
    try {
      await signInWithPopup(auth, new FacebookAuthProvider());
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/argument-error');
    }
    // Google mock still consumable.
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(result.user.uid).toBe('g-user');
  });
});

describe('signInWithCredential (sandbox)', () => {
  it('consumes a mock keyed by credential.providerId', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'apple.com', true);
    authSandbox.mockSignInResult(auth, {
      user: makeFakeUser('apple-1', 'a@example.com'),
      providerId: 'apple.com',
      operationType: 'signIn',
    });
    const provider = new OAuthProvider('apple.com');
    const credential = provider.credential({ idToken: 'fake-id-token' });
    const result = await signInWithCredential(auth, credential);
    expect(result.user.uid).toBe('apple-1');
    expect(auth.currentUser?.uid).toBe('apple-1');
  });

  it('throws auth/no-mock-configured without a pre-staged mock', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    const cred = GoogleAuthProvider.credential('id-token');
    try {
      await signInWithCredential(auth, cred);
      throw new Error('expected throw');
    } catch (e) {
      // signInWithCredential is NOT a popup/resolver flow (real firebase/auth
      // opens no UI for it), so it keeps the mock-or-throw affordance.
      expect((e as { code: string }).code).toBe('auth/no-mock-configured');
    }
  });
});
