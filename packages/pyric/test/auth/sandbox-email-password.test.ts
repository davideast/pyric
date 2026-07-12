/**
 * Email/password sign-in — sandbox target.
 *
 * Covers `signInWithEmailAndPassword` against a seeded user DB
 * (success + `auth/user-not-found` + `auth/wrong-password`),
 * `createUserWithEmailAndPassword` (success + `auth/email-already-in-use`),
 * custom claims surfacing in `getIdTokenResult`, and the
 * sandbox.currentUser bridge (rules engine reads `auth.token.role`
 * etc. through the same path).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  signOut,
} from '../../src/auth/index.js';

describe('sandbox email/password sign-in', () => {
  it('signs in a seeded user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'pw1' },
    ]);
    const credential = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw1');
    // null, not 'password' — matches prod (oracle auth-createUser-operationType
    // pins providerId: null; upstream providerIdForResponse returns null for
    // email/password — only OAuth/phone responses carry a providerId).
    // Flipped from 'password' as part of AUTH-B2 (the committed oracle was
    // the prod truth that contradicted the old assertion).
    expect(credential.providerId).toBeNull();
    expect(credential.user.uid).toBe('alice');
    expect(credential.user.email).toBe('alice@example.com');
    expect(credential.user.isAnonymous).toBe(false);
    expect(auth.currentUser?.uid).toBe('alice');
  });

  it('throws auth/user-not-found for unknown email', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await signInWithEmailAndPassword(auth, 'ghost@example.com', 'pw');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/user-not-found');
    }
  });

  it('throws auth/wrong-password for bad password', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'right' },
    ]);
    try {
      await signInWithEmailAndPassword(auth, 'alice@example.com', 'wrong');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/wrong-password');
    }
  });

  it('email lookup is case-insensitive', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'Alice@Example.com', password: 'pw' },
    ]);
    const credential = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw');
    expect(credential.user.uid).toBe('alice');
  });

  it('surfaces customClaims via getIdTokenResult', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      {
        uid: 'admin',
        email: 'admin@example.com',
        password: 'pw',
        customClaims: { role: 'admin', tier: 5 },
      },
    ]);
    const credential = await signInWithEmailAndPassword(auth, 'admin@example.com', 'pw');
    const result = await credential.user.getIdTokenResult();
    expect(result.claims['role']).toBe('admin');
    expect(result.claims['tier']).toBe(5);
  });

  it('writes customClaims into sandbox.currentUser.token (rules-engine bridge)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      {
        uid: 'mod',
        email: 'mod@example.com',
        password: 'pw',
        customClaims: { role: 'moderator' },
      },
    ]);
    await signInWithEmailAndPassword(auth, 'mod@example.com', 'pw');
    expect(sandbox.currentUser?.uid).toBe('mod');
    expect(sandbox.currentUser?.token?.['role']).toBe('moderator');
  });

  it('createUserWithEmailAndPassword adds to the DB', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const created = await createUserWithEmailAndPassword(auth, 'new@example.com', 'pw-123');
    expect(created.user.email).toBe('new@example.com');
    expect(created.user.isAnonymous).toBe(false);
    expect(auth.currentUser?.uid).toBe(created.user.uid);

    // Subsequent sign-in works:
    await signOut(auth);
    const re = await signInWithEmailAndPassword(auth, 'new@example.com', 'pw-123');
    expect(re.user.uid).toBe(created.user.uid);
  });

  it('createUserWithEmailAndPassword returns providerId: null (AUTH-B2 lock)', async () => {
    // Locks AUTH-B2 against the committed oracle
    // scripts/oracle/observations/auth-createUser-operationType.json,
    // which pins providerId: null (and operationType: 'signIn') for the
    // email/password create path. Upstream providerIdForResponse returns
    // null because the signUp response carries no providerId/phoneNumber.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const created = await createUserWithEmailAndPassword(auth, 'pidnull@example.com', 'pw-123');
    expect(created.providerId).toBeNull();
    expect(created.operationType).toBe('signIn');
  });

  it('createUserWithEmailAndPassword rejects duplicates', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'dup@example.com', 'pw-123');
    try {
      await createUserWithEmailAndPassword(auth, 'dup@example.com', 'pw-123');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/email-already-in-use');
    }
  });

  // ── Email format validation (matrix #18) ────────────────────────────
  // Prod rejects malformed emails with `auth/invalid-email`; sandbox
  // matches per oracle observation
  // `scripts/oracle/observations/auth-row-18-invalid-email-error-code.json`.

  it('createUserWithEmailAndPassword throws auth/invalid-email for malformed email', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, 'not-an-email', 'somepass123');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/invalid-email');
    }
    // No user should have been minted.
    expect(auth.currentUser).toBeNull();
  });

  it('createUserWithEmailAndPassword throws auth/invalid-email for empty email', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, '', 'somepass123');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/invalid-email');
    }
    expect(auth.currentUser).toBeNull();
  });

  it('createUserWithEmailAndPassword throws auth/invalid-email for email without domain', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, 'alice@', 'somepass123');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/invalid-email');
    }
    expect(auth.currentUser).toBeNull();
  });

  it('createUserWithEmailAndPassword throws auth/invalid-email for empty local-part', async () => {
    // `@` at index 0 — no local-part before the `@`. Guards against the
    // `atIdx <= 0` -> `atIdx < 0` mutant, which would let `@example.com`
    // through (an `@` at the very start is still `>= 0`, so a strict
    // "no `@` at all" check misses this shape).
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, '@example.com', 'pw123456');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/invalid-email');
    }
    expect(auth.currentUser).toBeNull();
  });

  it('signInWithEmailAndPassword throws auth/invalid-email for malformed email', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'right-password' },
    ]);
    try {
      await signInWithEmailAndPassword(auth, 'not-an-email', 'right-password');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/invalid-email');
    }
    // Validation must fire before lookup — no user signed in.
    expect(auth.currentUser).toBeNull();
  });

  // ── Password strength validation (matrix #19) ────────────────────────
  // Prod rejects passwords shorter than 6 chars with `auth/weak-password`
  // per oracle observation
  // `scripts/oracle/observations/auth-row-19-weak-password-error-code.json`.

  it('createUserWithEmailAndPassword throws auth/weak-password for short password', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, 'new@example.com', '12345');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/weak-password');
    }
    expect(auth.currentUser).toBeNull();
  });

  it('createUserWithEmailAndPassword throws auth/weak-password for empty password', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    try {
      await createUserWithEmailAndPassword(auth, 'new@example.com', '');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('auth/weak-password');
    }
    expect(auth.currentUser).toBeNull();
  });

  it('createUserWithEmailAndPassword accepts 6-char passwords (matches prod threshold)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await createUserWithEmailAndPassword(auth, 'edge@example.com', '123456');
    expect(cred.user.email).toBe('edge@example.com');
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
  });

  it('signInWithEmailAndPassword does NOT validate strength against previously-weak seeded passwords', async () => {
    // Sign-in path should let in users whose stored password is weak
    // (e.g. seeded for a test). Only registration runs the strength
    // check — mirrors prod.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'legacy', email: 'legacy@example.com', password: 'weak' },
    ]);
    const cred = await signInWithEmailAndPassword(auth, 'legacy@example.com', 'weak');
    expect(cred.user.uid).toBe('legacy');
  });

  it('signed-in users have non-anonymous shape', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      {
        uid: 'bob',
        email: 'bob@example.com',
        password: 'pw',
        displayName: 'Bob the Builder',
      },
    ]);
    const credential = await signInWithEmailAndPassword(auth, 'bob@example.com', 'pw');
    expect(credential.user.displayName).toBe('Bob the Builder');
    expect(credential.user.isAnonymous).toBe(false);
  });
});
