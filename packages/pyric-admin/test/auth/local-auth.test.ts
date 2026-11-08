import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth as getClientAuth,
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
});
