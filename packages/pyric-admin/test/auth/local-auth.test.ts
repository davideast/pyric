import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
  setPersistence,
  signInWithEmailAndPassword,
  updateEmail,
  updateProfile,
} from 'pyric/auth';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('local sandbox Auth arm', () => {
  it('synchronizes admin user creation, case-insensitive lookup, claims, and deletion with client Auth', async () => {
    const sandbox = initializeSandbox();
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-sync'));
    const clientAuth = getClientAuth(sandbox);

    await adminAuth.createUser({
      uid: 'user-1',
      email: 'member@example.com',
      password: 'secret-pw',
    });

    const byUpper = await adminAuth.getUserByEmail('MEMBER@EXAMPLE.COM');
    expect(byUpper.uid).toBe('user-1');

    const { user } = await signInWithEmailAndPassword(clientAuth, 'member@example.com', 'secret-pw');
    expect(user.uid).toBe('user-1');

    getAdminFirestore(sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      allow read: if request.auth != null && request.auth.token.role == 'owner';
    }
  }
}`);

    await adminAuth.setCustomUserClaims('user-1', { role: 'owner' });
    await user.getIdToken(true);
    const snap = await getDoc(doc(getFirestore(sandbox), 'orgs/org-1'));
    expect(snap.exists()).toBe(false);

    const issuedToken = await user.getIdToken();
    await adminAuth.deleteUser('user-1');
    await expect(adminAuth.verifyIdToken(issuedToken, true)).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });
    await expect(user.getIdToken(true)).rejects.toMatchObject({
      code: 'auth/user-token-expired',
    });
    expect(clientAuth.currentUser).toBeNull();
  });

  it('clears both admin and client user pools on sandbox.reset()', async () => {
    const sandbox = initializeSandbox();
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-reset'));
    const clientAuth = getClientAuth(sandbox);

    await createUserWithEmailAndPassword(clientAuth, 'direct@example.com', 'secret-pw');
    await adminAuth.createUser({ uid: 'user-2', email: 'admin@example.com', password: 'secret-pw' });

    sandbox.reset();

    await expect(adminAuth.getUser('user-2')).rejects.toMatchObject({ code: 'auth/user-not-found' });
    await expect(adminAuth.getUserByEmail('direct@example.com')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });
  });

  it('reflects client profile, email, and sign-in mutations on admin-created users without stale caching', async () => {
    const sandbox = initializeSandbox();
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-live-mutations'));
    const clientAuth = getClientAuth(sandbox);

    const passwordless = await adminAuth.createUser({ uid: 'user-nopw', email: 'nopw@example.com' });
    expect(passwordless.providerData).toEqual([]);

    const created = await adminAuth.createUser({
      uid: 'user-live',
      email: 'old@example.com',
      password: 'secret-pw',
      displayName: 'Before',
    });
    expect(created.providerData.map((p) => p.providerId)).toEqual(['password']);

    await adminAuth.setCustomUserClaims('user-live', { tier: 'pro' });

    const { user } = await signInWithEmailAndPassword(clientAuth, 'old@example.com', 'secret-pw');
    await updateProfile(user, { displayName: 'After', photoURL: 'https://example.com/avatar.png' });
    await updateEmail(user, 'new@example.com');

    const byUid = await adminAuth.getUser('user-live');
    expect(byUid.displayName).toBe('After');
    expect(byUid.photoURL).toBe('https://example.com/avatar.png');
    expect(byUid.email).toBe('new@example.com');
    expect(byUid.metadata.lastSignInTime.length).toBeGreaterThan(0);
    expect(byUid.customClaims).toEqual({ tier: 'pro' });

    const byNewEmail = await adminAuth.getUserByEmail('NEW@EXAMPLE.COM');
    expect(byNewEmail.uid).toBe('user-live');
    await expect(adminAuth.getUserByEmail('old@example.com')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });
  });

  it('observes client deleteUser on an admin-created user and permits recreating the uid', async () => {
    const sandbox = initializeSandbox();
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-client-delete'));
    const clientAuth = getClientAuth(sandbox);

    await adminAuth.createUser({
      uid: 'user-del',
      email: 'delete-me@example.com',
      password: 'secret-pw',
    });
    const { user } = await signInWithEmailAndPassword(clientAuth, 'delete-me@example.com', 'secret-pw');
    await deleteUser(user);

    await expect(adminAuth.getUser('user-del')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });
    await expect(adminAuth.getUserByEmail('delete-me@example.com')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });

    const recreated = await adminAuth.createUser({
      uid: 'user-del',
      email: 'recreated@example.com',
      password: 'secret-pw',
    });
    expect(recreated.uid).toBe('user-del');
    expect(recreated.email).toBe('recreated@example.com');
  });

  it('rejects operations on a retained Auth handle after deleteApp(app)', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'local-deleted-app');
    const adminAuth = getAuth(app);
    await deleteApp(app);

    await expect(
      Promise.resolve().then(() => adminAuth.createCustomToken('user-1')),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(
      Promise.resolve().then(() =>
        adminAuth.createUser({ uid: 'user-1', email: 'u1@example.com', password: 'secret-pw' }),
      ),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(
      Promise.resolve().then(() => adminAuth.getUser('user-1')),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
  });

  it('preserves client Auth users and persisted session storage on sandbox.dispose()', async () => {
    const map = new Map<string, string>();
    const memStorage = {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => {
        map.clear();
      },
    };
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'local-auth-dispose-preserve',
      backend: 'memory',
      flushIntervalMs: 5,
      sessionStorage: { local: memStorage, session: memStorage },
    });
    const clientAuth = getClientAuth(sandbox);
    await setPersistence(clientAuth, browserLocalPersistence);
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-dispose-preserve'));
    await adminAuth.createUser({ uid: 'user-1', email: 'u1@example.com', password: 'secret-pw' });
    await signInWithEmailAndPassword(clientAuth, 'u1@example.com', 'secret-pw');
    await new Promise((resolve) => setTimeout(resolve, 25));

    sandbox.dispose();

    expect(clientAuthSandbox.listUsers(clientAuth)).toHaveLength(1);
    expect(map.size).toBeGreaterThan(0);
  });

  it('rejects createUser({ uid, password }) without email with auth/invalid-email instead of dropping password', async () => {
    const sandbox = initializeSandbox();
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-pw-no-email'));
    await expect(
      adminAuth.createUser({ uid: 'user-no-email', password: 'secret-pw' }),
    ).rejects.toMatchObject({
      code: 'auth/invalid-email',
    });
  });

  it('exposes auth.app, supports updateUser and paginated listUsers, and validates uids', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'local-parity');
    const adminAuth = getAuth(app);

    expect(adminAuth.app).toBe(app);

    await adminAuth.createUser({ uid: 'user-1', email: 'u1@example.com', password: 'secret-pw' });
    await adminAuth.createUser({ uid: 'user-2', email: 'u2@example.com', password: 'secret-pw' });
    await adminAuth.createUser({ uid: 'user-3', email: 'u3@example.com', password: 'secret-pw' });

    const updated = await adminAuth.updateUser('user-1', {
      displayName: 'User One',
      photoURL: 'https://example.com/u1.png',
      phoneNumber: '+15555550101',
      emailVerified: true,
    });
    expect(updated.displayName).toBe('User One');
    expect(updated.photoURL).toBe('https://example.com/u1.png');
    expect(updated.phoneNumber).toBe('+15555550101');
    expect(updated.providerData.map((p) => p.providerId).sort()).toEqual(['password', 'phone']);
    expect(updated.emailVerified).toBe(true);

    await expect(
      adminAuth.updateUser('user-2', {
        email: 'changed-u2@example.com',
        phoneNumber: '+15555550101',
      }),
    ).rejects.toMatchObject({ code: 'auth/phone-number-already-exists' });
    const unchangedUser2 = await adminAuth.getUser('user-2');
    expect(unchangedUser2.email).toBe('u2@example.com');
    expect((await adminAuth.getUserByEmail('u2@example.com')).uid).toBe('user-2');
    await expect(adminAuth.getUserByEmail('changed-u2@example.com')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });

    const cleared = await adminAuth.updateUser('user-1', {
      displayName: null,
      photoURL: null,
      phoneNumber: null,
    });
    expect(cleared.displayName).toBeUndefined();
    expect(cleared.photoURL).toBeUndefined();
    expect(cleared.phoneNumber).toBeUndefined();
    expect(cleared.providerData.map((p) => p.providerId)).toEqual(['password']);

    const page1 = await adminAuth.listUsers(2);
    expect(page1.users.map((u) => u.uid)).toEqual(['user-1', 'user-2']);
    expect(typeof page1.pageToken).toBe('string');

    const page2 = await adminAuth.listUsers(2, page1.pageToken);
    expect(page2.users.map((u) => u.uid)).toEqual(['user-3']);
    expect(page2.pageToken).toBeUndefined();

    await expect(adminAuth.listUsers(0)).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(adminAuth.listUsers(1001)).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(adminAuth.listUsers(1, '')).rejects.toMatchObject({ code: 'auth/invalid-page-token' });
    await expect(adminAuth.listUsers(1, 'invalid-cursor')).rejects.toMatchObject({
      code: 'auth/invalid-page-token',
    });

    await expect(adminAuth.deleteUser('')).rejects.toMatchObject({ code: 'auth/invalid-uid' });
    await expect(adminAuth.getUser('')).rejects.toMatchObject({ code: 'auth/invalid-uid' });
    await expect(adminAuth.setCustomUserClaims('', { role: 'member' })).rejects.toMatchObject({
      code: 'auth/invalid-uid',
    });
    await expect(adminAuth.updateUser('', { displayName: 'Nope' })).rejects.toMatchObject({
      code: 'auth/invalid-uid',
    });
  });

  it('exposes tokensValidAfterTime on UserRecord and toJSON() before and after revokeRefreshTokens', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    const createdAtMs = Date.parse('2026-05-01T10:00:00.750Z');
    clock.set(createdAtMs);
    const adminAuth = getAuth(initializeApp({ sandbox }, 'local-valid-after'));

    const created = await adminAuth.createUser({ uid: 'u1', email: 'u1@example.com' });
    const expectedCreatedUtc = new Date(Math.floor(createdAtMs / 1000) * 1000).toUTCString();
    expect(created.tokensValidAfterTime).toBe(expectedCreatedUtc);
    expect(created.toJSON().tokensValidAfterTime).toBe(expectedCreatedUtc);

    const revokedAtMs = Date.parse('2026-05-01T10:05:12.900Z');
    clock.set(revokedAtMs);
    await adminAuth.revokeRefreshTokens('u1');
    const expectedRevokedUtc = new Date(Math.floor(revokedAtMs / 1000) * 1000).toUTCString();

    const byUid = await adminAuth.getUser('u1');
    const byEmail = await adminAuth.getUserByEmail('u1@example.com');
    const listed = await adminAuth.listUsers();
    for (const record of [byUid, byEmail, listed.users[0]]) {
      expect(record?.tokensValidAfterTime).toBe(expectedRevokedUtc);
      expect(record?.toJSON().tokensValidAfterTime).toBe(expectedRevokedUtc);
    }

    // Revocation timestamp remains visible even when the account is disabled.
    const disabled = await adminAuth.updateUser('u1', { disabled: true });
    expect(disabled.tokensValidAfterTime).toBe(expectedRevokedUtc);
    expect(disabled.toJSON().tokensValidAfterTime).toBe(expectedRevokedUtc);
  });

  it('advances listUsers(maxResults, pageToken) without skipping or duplicating users when the last-returned or next-boundary user is deleted', async () => {
    // 1. deleteLastReturnedUser: [a1, a2, a3] -> listUsers(1) -> delete a1 -> [a2], [a3]
    const sandboxA = initializeSandbox();
    const authA = getAuth(initializeApp({ sandbox: sandboxA }, 'local-cursor-del-returned'));
    await authA.createUser({ uid: 'a1' });
    await authA.createUser({ uid: 'a2' });
    await authA.createUser({ uid: 'a3' });

    const pageA1 = await authA.listUsers(1);
    expect(pageA1.users.map((u) => u.uid)).toEqual(['a1']);
    expect(typeof pageA1.pageToken).toBe('string');

    await authA.deleteUser('a1');

    const pageA2 = await authA.listUsers(1, pageA1.pageToken);
    expect(pageA2.users.map((u) => u.uid)).toEqual(['a2']);
    expect(typeof pageA2.pageToken).toBe('string');

    const pageA3 = await authA.listUsers(1, pageA2.pageToken);
    expect(pageA3.users.map((u) => u.uid)).toEqual(['a3']);
    expect(pageA3.pageToken).toBeUndefined();

    // 2. deleteNextBoundaryUser: [b1, b2, b3] -> listUsers(1) -> delete b2 -> [b3]
    const sandboxB = initializeSandbox();
    const authB = getAuth(initializeApp({ sandbox: sandboxB }, 'local-cursor-del-next'));
    await authB.createUser({ uid: 'b1' });
    await authB.createUser({ uid: 'b2' });
    await authB.createUser({ uid: 'b3' });

    const pageB1 = await authB.listUsers(1);
    expect(pageB1.users.map((u) => u.uid)).toEqual(['b1']);
    expect(typeof pageB1.pageToken).toBe('string');

    await authB.deleteUser('b2');

    const pageB2 = await authB.listUsers(1, pageB1.pageToken);
    expect(pageB2.users.map((u) => u.uid)).toEqual(['b3']);
    expect(pageB2.pageToken).toBeUndefined();

    // 3. Out-of-order creation, deleting multiple preceding users, and recreating the cursor uid
    const sandboxC = initializeSandbox();
    const authC = getAuth(initializeApp({ sandbox: sandboxC }, 'local-cursor-keyset'));
    await authC.createUser({ uid: 'c3' });
    await authC.createUser({ uid: 'c1' });
    await authC.createUser({ uid: 'c4' });
    await authC.createUser({ uid: 'c2' });

    const pageC1 = await authC.listUsers(2);
    expect(pageC1.users.map((u) => u.uid)).toEqual(['c1', 'c2']);
    expect(typeof pageC1.pageToken).toBe('string');

    await authC.deleteUser('c1');
    await authC.deleteUser('c2');
    await authC.createUser({ uid: 'c2' });

    const pageC2 = await authC.listUsers(2, pageC1.pageToken);
    expect(pageC2.users.map((u) => u.uid)).toEqual(['c3', 'c4']);
    expect(pageC2.pageToken).toBeUndefined();
  });

  it('mints and verifies session cookies with checkRevoked across revocation, disable, delete, and expiry', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    const startMs = Date.UTC(2026, 5, 1, 10, 0, 0);
    clock.set(startMs);
    const app = initializeApp({ sandbox }, 'local-session-cookie');
    const adminAuth = getAuth(app);
    const clientAuth = getClientAuth(sandbox);

    await adminAuth.createUser({
      uid: 'ssr-user',
      email: 'ssr@example.com',
      password: 'secret-pw',
    });
    await adminAuth.setCustomUserClaims('ssr-user', { plan: 'pro' });
    const { user } = await signInWithEmailAndPassword(clientAuth, 'ssr@example.com', 'secret-pw');
    const idToken = await user.getIdToken();

    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: 24 * 60 * 60 * 1000,
    });
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    expect(decoded.uid).toBe('ssr-user');
    expect(decoded.email).toBe('ssr@example.com');
    expect(decoded.plan).toBe('pro');
    expect(decoded.iss).toMatch(/^https:\/\/session\.firebase\.google\.com\//);

    // Revoking refresh tokens invalidates checkRevoked=true but not checkRevoked=false.
    clock.advance(2000);
    await adminAuth.revokeRefreshTokens('ssr-user');
    await expect(adminAuth.verifySessionCookie(sessionCookie)).resolves.toMatchObject({
      uid: 'ssr-user',
    });
    await expect(adminAuth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
      code: 'auth/session-cookie-revoked',
    });

    // Disabling the user rejects checkRevoked=true with auth/user-disabled.
    await adminAuth.updateUser('ssr-user', { disabled: true });
    await expect(adminAuth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
      code: 'auth/user-disabled',
    });

    // Deleting the user rejects checkRevoked=true with auth/user-not-found.
    await adminAuth.deleteUser('ssr-user');
    await expect(adminAuth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });

    // Advancing past expiresIn rejects with auth/session-cookie-expired.
    clock.set(startMs + 24 * 60 * 60 * 1000);
    await expect(adminAuth.verifySessionCookie(sessionCookie)).rejects.toMatchObject({
      code: 'auth/session-cookie-expired',
    });

    // Deleted app rejects both session cookie methods synchronously.
    await deleteApp(app);
    expect(() => adminAuth.createSessionCookie(idToken, { expiresIn: 300_000 })).toThrow(
      /has already been deleted/,
    );
    expect(() => adminAuth.verifySessionCookie(sessionCookie)).toThrow(/has already been deleted/);
  });
});
