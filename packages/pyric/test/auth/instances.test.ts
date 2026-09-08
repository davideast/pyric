/**
 * `Auth.tenantId`: the client handle's tenant scope.
 *
 * Locks the multi-tenancy contract a consumer writes against:
 *   - the property reads back what was assigned, and defaults to `null`;
 *   - a sign-in while it is set produces a `User` carrying that `tenantId`
 *     (the `firebase/auth` contract), and rules for that session see
 *     `request.auth.token.firebase.tenant`;
 *   - a sign-in while it is `null` sets no tenant claim at all, so a rule
 *     comparing against a tenant denies;
 *   - the tenant is fixed at sign-in, so a restored session keeps it.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from '../../src/auth/index.js';

const TENANT_SCOPED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenant}/notes/{note} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenant;
    }
  }
}`;

async function makeSandbox() {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(TENANT_SCOPED);
  return sandbox;
}

describe('Auth.tenantId', () => {
  it('defaults to null and reads back what was assigned', () => {
    const auth = getAuth(initializeSandbox());

    expect(auth.tenantId).toBeNull();

    auth.tenantId = 'tenant-alpha';
    expect(auth.tenantId).toBe('tenant-alpha');

    auth.tenantId = null;
    expect(auth.tenantId).toBeNull();
  });

  it('puts the tenant on the user an anonymous sign-in returns', async () => {
    const auth = getAuth(initializeSandbox());
    auth.tenantId = 'acme';

    const { user } = await signInAnonymously(auth);

    expect(user.tenantId).toBe('acme');
    expect(auth.currentUser?.tenantId).toBe('acme');
  });

  it('puts the tenant on the user an email/password sign-in returns', async () => {
    const auth = getAuth(initializeSandbox());
    auth.tenantId = 'acme';

    const created = await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123');
    expect(created.user.tenantId).toBe('acme');

    await signOut(auth);
    const signedIn = await signInWithEmailAndPassword(auth, 'alice@example.com', 'password123');
    expect(signedIn.user.tenantId).toBe('acme');
  });

  it('leaves tenantId null when no tenant is set', async () => {
    const auth = getAuth(initializeSandbox());

    const { user } = await signInAnonymously(auth);

    expect(user.tenantId).toBeNull();
  });

  it('fixes the tenant at sign-in, so a later reassignment leaves the session alone', async () => {
    const auth = getAuth(initializeSandbox());
    auth.tenantId = 'acme';
    const { user } = await signInAnonymously(auth);

    auth.tenantId = 'globex';

    expect(user.tenantId).toBe('acme');
    expect(auth.currentUser?.tenantId).toBe('acme');
  });

  it('keeps the tenant across a session restore', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    auth.tenantId = 'acme';
    const { user } = await createUserWithEmailAndPassword(auth, 'bob@example.com', 'password123');
    await signOut(auth);
    auth.tenantId = null;

    const restored = authSandbox.restoreSession(auth, user.uid);

    expect(restored.tenantId).toBe('acme');
  });
});

describe('Auth.tenantId reaches the rules engine', () => {
  it('allows a tenant-scoped write for a user signed in under that tenant', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    auth.tenantId = 'acme';
    await signInAnonymously(auth);

    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'tenants/acme/notes/n1'), { body: 'in tenant' });

    expect((await getDoc(doc(db, 'tenants/acme/notes/n1'))).data()).toEqual({ body: 'in tenant' });
  });

  it('denies a tenant-scoped write for a user signed in with tenantId null', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);

    const db = getFirestore(sandbox);

    await expect(setDoc(doc(db, 'tenants/acme/notes/n1'), { body: 'no tenant' }))
      .rejects.toThrow(/permission|denied/i);
  });

  it('denies a write scoped to a tenant the user did not sign in under', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    auth.tenantId = 'acme';
    await signInAnonymously(auth);

    const db = getFirestore(sandbox);

    await expect(setDoc(doc(db, 'tenants/globex/notes/n1'), { body: 'wrong tenant' }))
      .rejects.toThrow(/permission|denied/i);
  });
});
