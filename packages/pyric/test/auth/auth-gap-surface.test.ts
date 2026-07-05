/**
 * AUTH-GAP — the drop-in `User` / `Auth` / error surface.
 *
 * Locks the cheap real fields the plan calls for:
 *   - `User.photoURL` / `emailVerified` / `phoneNumber` / `providerId` /
 *     `providerData` present on sandbox-minted users;
 *   - `auth.signOut()` method form (alongside the free function);
 *   - sandbox auth errors are real `FirebaseError` instances with the
 *     `Firebase: … (auth/…)` message wrapper.
 * (The heavier surface — metadata / refreshToken / tenantId / reload /
 * delete / toJSON — is documented in COMPAT, not synthesized.)
 */
import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'firebase/app';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
} from '../../src/auth/index.js';

describe('AUTH-GAP: real User fields', () => {
  it('email/password user exposes photoURL / emailVerified / phoneNumber / providerId / providerData', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'u', email: 'u@example.com', password: 'pw1', displayName: 'U' },
    ]);
    const cred = await signInWithEmailAndPassword(auth, 'u@example.com', 'pw1');
    const u = cred.user;
    expect(u.photoURL).toBeNull();
    expect(u.emailVerified).toBe(false);
    expect(u.phoneNumber).toBeNull();
    expect(u.providerId).toBe('firebase');
    expect(Array.isArray(u.providerData)).toBe(true);
    expect(u.providerData).toHaveLength(1);
    expect(u.providerData[0]!.providerId).toBe('password');
    expect(u.providerData[0]!.email).toBe('u@example.com');
  });

  it('anonymous user has empty providerData', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await signInAnonymously(auth);
    expect(cred.user.providerData).toEqual([]);
    expect(cred.user.photoURL).toBeNull();
    expect(cred.user.emailVerified).toBe(false);
  });
});

describe('AUTH-GAP: auth.signOut() method form', () => {
  it('auth.signOut() signs the user out (same as the free function)', async () => {
    const auth = getAuth(initializeSandbox());
    await signInAnonymously(auth);
    expect(auth.currentUser).not.toBeNull();
    await auth.signOut();
    expect(auth.currentUser).toBeNull();
  });
});

describe('AUTH-GAP: FirebaseError instances + message wrapper', () => {
  it('a sandbox auth error is a real FirebaseError with the Firebase wrapper', async () => {
    const auth = getAuth(initializeSandbox());
    try {
      await signInWithEmailAndPassword(auth, 'not-an-email', 'pw123456');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FirebaseError);
      expect((e as FirebaseError).code).toBe('auth/invalid-email');
      // Matches the oracle: `Firebase: Error (auth/invalid-email).`
      expect((e as Error).message).toBe('Firebase: Error (auth/invalid-email).');
    }
  });

  it('weak-password error matches the oracle message wrapper exactly', async () => {
    const auth = getAuth(initializeSandbox());
    try {
      await import('../../src/auth/index.js').then((m) =>
        m.createUserWithEmailAndPassword(auth, 'new@example.com', '123'),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FirebaseError);
      expect((e as Error).message).toBe(
        'Firebase: Password should be at least 6 characters (auth/weak-password).',
      );
    }
  });
});
