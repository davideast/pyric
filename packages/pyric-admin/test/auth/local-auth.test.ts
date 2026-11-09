import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
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
      emailVerified: true,
    });
    expect(updated.displayName).toBe('User One');
    expect(updated.emailVerified).toBe(true);

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
});
