/**
 * Anonymous sign-in / sign-out — sandbox target.
 *
 * Covers the default state (`currentUser === null` until first
 * sign-in), the anonymous user shape (auto-uid, `isAnonymous: true`,
 * `email === null`), sandbox token issuance, and the two flips
 * (`signOut` clears currentUser; a second `signInAnonymously` mints
 * a fresh uid).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInAnonymously,
  signOut,
} from '../../src/auth/index.js';

describe('sandbox anonymous sign-in', () => {
  it('starts with currentUser === null', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    expect(auth.currentUser).toBe(null);
  });

  it('signInAnonymously mints an anonymous user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const credential = await signInAnonymously(auth);
    // Matches firebase/auth Web SDK: anonymous UserCredential.providerId is null.
    // Locked empirically by scripts/oracle/observations/auth-anonymous-credential-providerid.json.
    expect(credential.providerId).toBe(null);
    expect(credential.operationType).toBe('signIn');
    expect(credential.user.isAnonymous).toBe(true);
    expect(credential.user.email).toBe(null);
    expect(credential.user.displayName).toBe(null);
    expect(credential.user.uid).toMatch(/^anonymous-/);
    expect(auth.currentUser?.uid).toBe(credential.user.uid);
  });

  it('writes through to sandbox.currentUser', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    expect(sandbox.currentUser).not.toBe(null);
    expect(sandbox.currentUser?.uid).toBe(auth.currentUser!.uid);
  });

  it('signOut clears currentUser', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    await signOut(auth);
    expect(auth.currentUser).toBe(null);
    expect(sandbox.currentUser).toBe(null);
  });

  it('two anonymous sign-ins mint distinct uids', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const first = await signInAnonymously(auth);
    await signOut(auth);
    const second = await signInAnonymously(auth);
    expect(first.user.uid).not.toBe(second.user.uid);
  });

  it('signInAnonymously is idempotent while the anonymous user is still signed in', async () => {
    // Real `firebase/auth` reuses the existing anonymous user when
    // there's already one signed in (the persistence layer surfaces
    // them on next page load). The sandbox has no persistence layer,
    // but within one session a second `signInAnonymously` should
    // return the SAME user — otherwise React StrictMode (or any
    // pattern that double-invokes a mount effect) leaks a fresh
    // `anonymous-{N}` per mount, each with its own owner-only
    // profile docs nobody can clean up.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const first = await signInAnonymously(auth);
    const second = await signInAnonymously(auth);
    expect(second.user.uid).toBe(first.user.uid);
    expect(second.user.isAnonymous).toBe(true);
  });

  it('issues a sandbox-prefixed ID token', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const credential = await signInAnonymously(auth);
    const token = await credential.user.getIdToken();
    expect(token.startsWith('sandbox-id-token-')).toBe(true);
    expect(token).toContain(credential.user.uid);
  });

  it('getIdTokenResult includes synthesized standard claims', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const credential = await signInAnonymously(auth);
    const result = await credential.user.getIdTokenResult();
    expect(result.claims['sub']).toBe(credential.user.uid);
    expect(result.claims['aud']).toBe('pyric-sandbox');
    expect(typeof result.claims['exp']).toBe('number');
    expect(result.expirationTime).toEqual(expect.any(String));
    expect(result.authTime).toEqual(expect.any(String));
  });

  it('getAuth is idempotent for the same sandbox', () => {
    const sandbox = initializeSandbox();
    const a = getAuth(sandbox);
    const b = getAuth(sandbox);
    expect(a).toBe(b);
  });

  it('signOut on a fresh sandbox is a no-op (no throw)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signOut(auth);
    expect(auth.currentUser).toBe(null);
  });
});
