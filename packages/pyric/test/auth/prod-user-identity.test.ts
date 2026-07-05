/**
 * Prod-backend `User` reference identity (AUTH-B5) — sandbox-free.
 *
 * Upstream `auth.currentUser` is a stored field reassigned once per
 * sign-in (`core/auth/auth_impl.ts:98,792`), so repeat reads return the
 * SAME object. Our prod adapter (`adaptUser`) memoizes per upstream
 * `fb.User`; before the fix it minted a fresh wrapper per call and
 * `prodCurrentUser(auth) === prodCurrentUser(auth)` was false, despite
 * the docstring claiming reference equality held.
 *
 * Driven through the exported `prodCurrentUser` / `prodOnAuthStateChanged`
 * wrappers with a stub `fb.Auth` + `fb.User` — no live Firebase needed.
 */
import { describe, expect, it } from 'bun:test';
import * as fb from 'firebase/auth';
import { prodCurrentUser, prodOnAuthStateChanged } from '../../src/auth/prod-backend.js';

/** Minimal stub satisfying the fields `adaptUser` reads. */
function stubFbUser(uid: string): fb.User {
  return {
    uid,
    email: `${uid}@example.com`,
    emailVerified: true,
    displayName: `Display ${uid}`,
    photoURL: `https://example.com/${uid}.png`,
    phoneNumber: null,
    isAnonymous: false,
    providerId: 'firebase',
    providerData: [{
      uid,
      displayName: `Display ${uid}`,
      email: `${uid}@example.com`,
      phoneNumber: null,
      photoURL: `https://example.com/${uid}.png`,
      providerId: 'password',
    }],
    getIdToken: async () => `tok-${uid}`,
    getIdTokenResult: async () => ({
      token: `tok-${uid}`,
      claims: {},
      expirationTime: '',
      issuedAtTime: '',
      authTime: '',
      signInProvider: null,
      signInSecondFactor: null,
    }),
  } as unknown as fb.User;
}

describe('prod-backend User reference identity (AUTH-B5)', () => {
  it('prodCurrentUser returns the same adapted User across reads of the same fb.User', () => {
    const fbUser = stubFbUser('prod-1');
    const auth = { currentUser: fbUser } as unknown as fb.Auth;
    const a = prodCurrentUser(auth);
    const b = prodCurrentUser(auth);
    expect(a).not.toBeNull();
    expect(a).toBe(b!);
    expect(a!.email).toBe('prod-1@example.com');
    expect(a!.displayName).toBe('Display prod-1');
  });

  it('a different fb.User yields a distinct adapted User', () => {
    const auth1 = { currentUser: stubFbUser('prod-2') } as unknown as fb.Auth;
    const auth2 = { currentUser: stubFbUser('prod-3') } as unknown as fb.Auth;
    expect(prodCurrentUser(auth1)).not.toBe(prodCurrentUser(auth2));
  });

  it('an observer-delivered User is the same reference as prodCurrentUser', () => {
    const fbUser = stubFbUser('prod-4');
    let observerUser: ReturnType<typeof prodCurrentUser> = null;
    // Stub onAuthStateChanged: invoke the callback synchronously with our user.
    const auth = {
      currentUser: fbUser,
      onAuthStateChanged: (cb: (u: fb.User | null) => void) => {
        cb(fbUser);
        return () => {};
      },
    } as unknown as fb.Auth;
    prodOnAuthStateChanged(auth, (u) => { observerUser = u; });
    expect(observerUser).not.toBeNull();
    expect(observerUser).toBe(prodCurrentUser(auth)!);
  });
});
