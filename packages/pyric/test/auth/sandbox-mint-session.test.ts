/**
 * `sandbox.mintSession` — the per-connection identity substrate (#754).
 *
 * Locks the contract the serve worker's per-port sessions build on:
 *   - every kind mints an AUTHENTIC session (validated / really created)
 *     WITHOUT touching the global current user or firing auth listeners;
 *   - the returned AuthState drives rules exactly like a real sign-in
 *     (uid + custom claims on request.auth.token);
 *   - two anonymous mints = two distinct identities (the multi-user point);
 *   - `uid` kind mirrors restoreSession's errors (not-found / disabled).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
import {
  getAuth,
  onAuthStateChanged,
  sandbox as authSandbox,
} from '../../src/auth/index.js';

const OWNER_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /admins/{d} {
      allow read, write: if request.auth != null && request.auth.token.role == 'admin';
    }
  }
}`;

async function makeSandbox() {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(OWNER_ONLY);
  return sandbox;
}

describe('sandbox.mintSession — no global session change', () => {
  it('mints without setting currentUser or firing auth listeners', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    const fires: unknown[] = [];
    onAuthStateChanged(auth, (u) => fires.push(u));
    await new Promise((r) => setTimeout(r, 0)); // initial fire (null)
    const before = fires.length;

    const s = authSandbox.mintSession(auth, { kind: 'anonymous' });
    expect(s.user.isAnonymous).toBe(true);
    expect(s.state.uid).toBe(s.user.uid);

    await new Promise((r) => setTimeout(r, 0));
    expect(auth.currentUser).toBeNull();
    expect(fires.length).toBe(before); // no listener fire
  });

  it('two anonymous mints are two distinct identities', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    const a = authSandbox.mintSession(auth, { kind: 'anonymous' });
    const b = authSandbox.mintSession(auth, { kind: 'anonymous' });
    expect(a.user.uid).not.toBe(b.user.uid);
  });

  it('password kind validates credentials; createPassword creates', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);

    const created = authSandbox.mintSession(auth, {
      kind: 'createPassword', email: 'alice@example.com', password: 'password123',
    });
    expect(created.user.email).toBe('alice@example.com');
    expect(auth.currentUser).toBeNull();

    const signedIn = authSandbox.mintSession(auth, {
      kind: 'password', email: 'alice@example.com', password: 'password123',
    });
    expect(signedIn.user.uid).toBe(created.user.uid);

    expect(() =>
      authSandbox.mintSession(auth, { kind: 'password', email: 'alice@example.com', password: 'WRONG' }),
    ).toThrow();
  });

  it('uid kind mirrors restoreSession errors', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    expect(() => authSandbox.mintSession(auth, { kind: 'uid', uid: 'nope' }))
      .toThrow(/user-not-found/);

    authSandbox.seedUsers(auth, [{ uid: 'z', email: 'z@example.com', password: 'password123' }]);
    const s = authSandbox.mintSession(auth, { kind: 'uid', uid: 'z' });
    expect(s.user.email).toBe('z@example.com');
  });

  it('the minted AuthState drives rules like a real sign-in (uid + token claims)', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    const a = authSandbox.mintSession(auth, { kind: 'anonymous' });
    const b = authSandbox.mintSession(auth, { kind: 'anonymous' });

    const dbA = getFirestore(sandbox.withAuth(a.state));
    // Own doc: allowed.
    await setDoc(doc(dbA, `claims/${a.user.uid}`), { ok: true });
    // Someone else's doc: denied.
    await expect(setDoc(doc(dbA, `claims/${b.user.uid}`), { ok: false })).rejects.toThrow();

    // Custom claims ride request.auth.token.
    authSandbox.seedUsers(auth, [{
      uid: 'boss', email: 'boss@example.com', password: 'password123',
      customClaims: { role: 'admin' },
    }]);
    const boss = authSandbox.mintSession(auth, { kind: 'uid', uid: 'boss' });
    const dbBoss = getFirestore(sandbox.withAuth(boss.state));
    await setDoc(doc(dbBoss, 'admins/x'), { ok: true });
    await expect(setDoc(doc(dbA, 'admins/y'), { ok: false })).rejects.toThrow();
  });

  it('token accessors work on a detached-session user', async () => {
    const sandbox = await makeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [{
      uid: 'tok', email: 'tok@example.com', password: 'password123',
      customClaims: { plan: 'pro' },
    }]);
    const s = authSandbox.mintSession(auth, { kind: 'uid', uid: 'tok' });
    const token = await s.user.getIdToken();
    expect(token.length).toBeGreaterThan(0);
    const result = await s.user.getIdTokenResult();
    expect(result.claims.plan).toBe('pro');
    expect(result.signInProvider).toBe('password');
  });
});
