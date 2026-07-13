/**
 * AUTH-B9..B12 cluster probes.
 *
 * - B9: re-seeding a uid with a new email drops the stale email mapping.
 * - B10: a re-seed of customClaims is reflected in a held user's
 *   `getIdToken(true)` (live claims, not frozen-at-mint).
 * - B11: empty password → `auth/missing-password` (not wrong-password /
 *   user-not-found). Upstream `core/errors.ts:92,282,563`.
 * - B12: an unrecognized persistence marker throws
 *   `auth/argument-error` instead of silently coercing to LOCAL.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  sandbox as authSandbox,
  setPersistence,
  signInWithEmailAndPassword,
} from '../../src/auth/index.js';

describe('AUTH-B9: re-seed with new email drops the stale email', () => {
  it('the old email no longer signs in after a uid re-seed', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'u', email: 'old@example.com', password: 'pw1' },
    ]);
    authSandbox.seedUsers(auth, [
      { uid: 'u', email: 'new@example.com', password: 'pw1' },
    ]);
    // New email works:
    const cred = await signInWithEmailAndPassword(auth, 'new@example.com', 'pw1');
    expect(cred.user.uid).toBe('u');
    // Old email is gone:
    await expect(
      signInWithEmailAndPassword(auth, 'old@example.com', 'pw1'),
    ).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
});

describe('AUTH-B10: re-seeded claims reflected in held user getIdToken(true)', () => {
  it('a forced refresh on a held user picks up re-seeded customClaims', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'admin', email: 'admin@example.com', password: 'pw1', customClaims: { role: 'user' } },
    ]);
    const cred = await signInWithEmailAndPassword(auth, 'admin@example.com', 'pw1');
    const held = cred.user; // hold the User reference
    const before = await held.getIdTokenResult();
    expect(before.claims['role']).toBe('user');
    // Re-seed the SAME uid with elevated claims.
    authSandbox.seedUsers(auth, [
      { uid: 'admin', email: 'admin@example.com', password: 'pw1', customClaims: { role: 'admin' } },
    ]);
    const after = await held.getIdTokenResult(true); // forceRefresh
    expect(after.claims['role']).toBe('admin');
  });
});

describe('AUTH-B11: empty password → auth/missing-password', () => {
  it('signInWithEmailAndPassword with empty password emits missing-password', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'a', email: 'a@example.com', password: 'pw1' },
    ]);
    await expect(
      signInWithEmailAndPassword(auth, 'a@example.com', ''),
    ).rejects.toMatchObject({ code: 'auth/missing-password' });
  });

  it('missing-password fires before the user-DB lookup (no enumeration)', async () => {
    const auth = getAuth(initializeSandbox());
    // ghost@ isn't seeded — but the empty-password error must still win,
    // so a caller can't distinguish seeded vs unseeded by the error code.
    await expect(
      signInWithEmailAndPassword(auth, 'ghost@example.com', ''),
    ).rejects.toMatchObject({ code: 'auth/missing-password' });
  });
});

describe('AUTH-B12: setPersistence rejects unknown markers', () => {
  it('an unrecognized persistence type throws auth/argument-error', async () => {
    const auth = getAuth(initializeSandbox());
    await expect(
      setPersistence(auth, { type: 'BOGUS' } as never),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
  });
});
