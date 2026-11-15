/**
 * In-process `updateEmail()` verification reset, immediate token refresh,
 * session revocation, idempotent same-email handling, and Security Rules
 * propagation across Firestore, RTDB, and Storage.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { getDatabase, ref as dbRef, set as dbSet } from 'pyric/database';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { getStorageSandbox, ref as storageRef, uploadString } from 'pyric/storage';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  updateEmail,
} from '../../../src/auth/index.js';
import { mintCustomTokenFor } from '../../../src/auth/internal.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /verified/{id} {
      allow read, write: if request.auth != null
        && request.auth.token.email_verified == true;
    }
    match /byEmail/{id} {
      allow write: if request.auth != null
        && request.auth.token.email == 'new@example.com'
        && request.auth.token.email_verified == false;
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    verified: {
      '.write': 'auth != null && auth.token.email_verified == true',
    },
    byEmail: {
      '.write': "auth != null && auth.token.email == 'new@example.com' && auth.token.email_verified == false",
    },
  },
};

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /verified/{name} {
      allow write: if request.auth != null
        && request.auth.token.email_verified == true;
    }
    match /byEmail/{name} {
      allow write: if request.auth != null
        && request.auth.token.email == 'new@example.com'
        && request.auth.token.email_verified == false;
    }
  }
}`;

async function outcome(op: () => Promise<unknown>): Promise<'allowed' | 'denied'> {
  try {
    await op();
    return 'allowed';
  } catch {
    return 'denied';
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setupVerifiedEnv(email = 'verified@example.com') {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  const record = authSandbox.createUser(auth, {
    email,
    password: 'password123',
    emailVerified: true,
  });
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
  setDatabaseRules(sandbox, RTDB_RULES);
  const storage = getStorageSandbox(sandbox, {
    dbName: `email-update-${Math.random().toString(36).slice(2, 10)}`,
    rules: STORAGE_RULES,
  });
  const fs = getFirestore(sandbox);
  const rtdb = getDatabase(sandbox);
  const cred = await signInWithEmailAndPassword(auth, email, 'password123');
  return { sandbox, auth, uid: record.uid, user: cred.user, fs, rtdb, storage };
}

describe('in-process updateEmail email_verified reset and token refresh', () => {
  it('resets emailVerified, refreshes cached token, fires onIdTokenChanged only, and denies verified-only rules across all services', async () => {
    const { auth, uid, user, fs, rtdb, storage } = await setupVerifiedEnv();

    expect(user.emailVerified).toBe(true);
    const beforeToken = await user.getIdTokenResult(false);
    expect(beforeToken.claims.email).toBe('verified@example.com');
    expect(beforeToken.claims.email_verified).toBe(true);

    expect(await outcome(() => setDoc(doc(fs, 'verified/d1'), { ok: true }))).toBe('allowed');
    expect(await outcome(() => dbSet(dbRef(rtdb, 'verified/k1'), true))).toBe('allowed');
    expect(await outcome(() => uploadString(storageRef(storage, 'verified/f1.txt'), 'ok'))).toBe('allowed');

    const authStateEvents: Array<string | null> = [];
    const idTokenEvents: Array<{ email: string | null; emailVerified: boolean | undefined } | null> = [];
    const unsubState = onAuthStateChanged(auth, (u) => authStateEvents.push(u?.uid ?? null));
    const unsubToken = onIdTokenChanged(auth, (u) => {
      if (u === null) {
        idTokenEvents.push(null);
      } else {
        idTokenEvents.push({ email: u.email, emailVerified: u.emailVerified });
      }
    });
    await flushMicrotasks();
    authStateEvents.length = 0;
    idTokenEvents.length = 0;

    await updateEmail(user, 'new@example.com');
    await flushMicrotasks();

    unsubState();
    unsubToken();

    // User handle and stored record reflect the new unverified address.
    expect(user.email).toBe('new@example.com');
    expect(user.emailVerified).toBe(false);
    expect(auth.currentUser?.email).toBe('new@example.com');
    expect(auth.currentUser?.emailVerified).toBe(false);
    expect(user.providerData?.[0]?.email).toBe('new@example.com');

    const stored = authSandbox.listUsers(auth).find((entry) => entry.uid === uid);
    expect(stored?.email).toBe('new@example.com');
    expect(stored?.emailVerified).toBe(false);

    // Unforced token read immediately reflects new email and email_verified: false.
    const afterToken = await user.getIdTokenResult(false);
    expect(afterToken.token).not.toBe(beforeToken.token);
    expect(afterToken.claims.email).toBe('new@example.com');
    expect(afterToken.claims.email_verified).toBe(false);
    const firebaseClaim = afterToken.claims.firebase as { identities?: { email?: string[] } } | undefined;
    expect(firebaseClaim?.identities?.email).toEqual(['new@example.com']);
    expect(afterToken.authTime).toBe(beforeToken.authTime);

    // onIdTokenChanged fires; onAuthStateChanged does not (uid unchanged).
    expect(authStateEvents).toEqual([]);
    expect(idTokenEvents).toEqual([{ email: 'new@example.com', emailVerified: false }]);

    // Security Rules immediately see email_verified == false and new email without getIdToken(true).
    expect(await outcome(() => setDoc(doc(fs, 'verified/d2'), { ok: true }))).toBe('denied');
    expect(await outcome(() => dbSet(dbRef(rtdb, 'verified/k2'), true))).toBe('denied');
    expect(await outcome(() => uploadString(storageRef(storage, 'verified/f2.txt'), 'nope'))).toBe('denied');

    expect(await outcome(() => setDoc(doc(fs, 'byEmail/d1'), { ok: true }))).toBe('allowed');
    expect(await outcome(() => dbSet(dbRef(rtdb, 'byEmail/k1'), true))).toBe('allowed');
    expect(await outcome(() => uploadString(storageRef(storage, 'byEmail/f1.txt'), 'ok'))).toBe('allowed');
  });

  it('treats same-email updateEmail (exact and case-insensitive) as idempotent without resetting emailVerified or reminting', async () => {
    const { auth, uid, user, fs, rtdb, storage } = await setupVerifiedEnv('Ada@Example.com');

    const beforeToken = await user.getIdTokenResult(false);
    const idTokenEvents: Array<string | null> = [];
    const unsubToken = onIdTokenChanged(auth, (u) => idTokenEvents.push(u?.email ?? null));
    await flushMicrotasks();
    idTokenEvents.length = 0;

    await updateEmail(user, 'Ada@Example.com');
    await updateEmail(user, 'ada@example.com');
    await flushMicrotasks();
    unsubToken();

    expect(user.emailVerified).toBe(true);
    expect(auth.currentUser?.emailVerified).toBe(true);
    const stored = authSandbox.listUsers(auth).find((entry) => entry.uid === uid);
    expect(stored?.emailVerified).toBe(true);

    const afterToken = await user.getIdTokenResult(false);
    expect(afterToken.token).toBe(beforeToken.token);
    expect(afterToken.claims.email_verified).toBe(true);
    expect(idTokenEvents).toEqual([]);

    expect(await outcome(() => setDoc(doc(fs, 'verified/same'), { ok: true }))).toBe('allowed');
    expect(await outcome(() => dbSet(dbRef(rtdb, 'verified/same'), true))).toBe('allowed');
    expect(await outcome(() => uploadString(storageRef(storage, 'verified/same.txt'), 'ok'))).toBe('allowed');
  });

  it('revokes other sessions of the account while keeping the updating session able to refresh', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    const appA = createAppForSandbox(sandbox, {}, 'device-a');
    const appB = createAppForSandbox(sandbox, {}, 'device-b');
    const authA = getAuth(appA);
    const authB = getAuth(appB);

    authSandbox.createUser(authA, {
      email: 'shared@example.com',
      password: 'password123',
      emailVerified: true,
    });

    const credA = await signInWithEmailAndPassword(authA, 'shared@example.com', 'password123');
    const credB = await signInWithEmailAndPassword(authB, 'shared@example.com', 'password123');

    // Move past the whole-second revocation boundary.
    clock.advance(2_000);
    await updateEmail(credA.user, 'moved@example.com');

    // Updating session keeps refreshing.
    const refreshedA = await credA.user.getIdTokenResult(true);
    expect(refreshedA.claims.email).toBe('moved@example.com');
    expect(refreshedA.claims.email_verified).toBe(false);

    // Other session is revoked on next refresh and signed out.
    await expect(credB.user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
    expect(authB.currentUser).toBeNull();
  });

  it('preserves custom-token signInProvider and developer claims while resetting email_verified', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const created = authSandbox.createUser(auth, {
      uid: 'custom-uid',
      email: 'custom@example.com',
      emailVerified: true,
    });
    const customToken = mintCustomTokenFor(auth, created.uid, { tier: 'gold' });
    const { user } = await signInWithCustomToken(auth, customToken);

    const before = await user.getIdTokenResult(false);
    expect(before.signInProvider).toBe('custom');
    expect(before.claims.tier).toBe('gold');
    expect(before.claims.email_verified).toBe(true);

    await updateEmail(user, 'custom-next@example.com');

    const afterUnforced = await user.getIdTokenResult(false);
    expect(afterUnforced.signInProvider).toBe('custom');
    expect(afterUnforced.claims.tier).toBe('gold');
    expect(afterUnforced.claims.email).toBe('custom-next@example.com');
    expect(afterUnforced.claims.email_verified).toBe(false);
  });

  it('leaves emailVerified and token untouched when updateEmail fails validation or uniqueness', async () => {
    const { auth, user, fs } = await setupVerifiedEnv();
    authSandbox.createUser(auth, {
      email: 'taken@example.com',
      password: 'password123',
      emailVerified: false,
    });
    const beforeToken = await user.getIdToken(false);

    await expect(updateEmail(user, 'taken@example.com')).rejects.toMatchObject({
      code: 'auth/email-already-in-use',
    });
    await expect(updateEmail(user, 'not-an-email')).rejects.toMatchObject({
      code: 'auth/invalid-email',
    });

    expect(user.email).toBe('verified@example.com');
    expect(user.emailVerified).toBe(true);
    expect(await user.getIdToken(false)).toBe(beforeToken);
    expect(await outcome(() => setDoc(doc(fs, 'verified/still-ok'), { ok: true }))).toBe('allowed');
  });
});
