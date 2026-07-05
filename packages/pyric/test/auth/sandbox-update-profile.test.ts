/**
 * `updateProfile(user, profile)` — sandbox target (#746).
 *
 * `firebase/auth`'s `updateProfile` updates the signed-in user's
 * `displayName` / `photoURL` in place. Locks:
 *   - `auth.currentUser` (same object ref) reflects the new fields, plus the
 *     first `providerData` entry.
 *   - the stored user-DB record (via `sandbox.listUsers`) is updated, so a
 *     later rebuild (session restore) keeps the profile.
 *   - `null` clears a field; an omitted field is left untouched.
 *   - it does NOT fire an extra `onAuthStateChanged` (matching prod).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sandbox as authSandbox,
  signInAnonymously,
  updateProfile,
} from '../../src/auth/index.js';

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('updateProfile — sandbox', () => {
  it('updates auth.currentUser (same ref) + providerData on an email user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123');

    const before = auth.currentUser;
    expect(before).toBe(cred.user); // same reference

    await updateProfile(cred.user, {
      displayName: 'Alice',
      photoURL: 'http://example.com/alice.png',
    });

    // Same object ref carries the change.
    expect(auth.currentUser).toBe(before);
    expect(auth.currentUser?.displayName).toBe('Alice');
    expect(auth.currentUser?.photoURL).toBe('http://example.com/alice.png');
    // providerData[0] mirrors the profile.
    expect(auth.currentUser?.providerData?.[0]?.displayName).toBe('Alice');
    expect(auth.currentUser?.providerData?.[0]?.photoURL).toBe('http://example.com/alice.png');
  });

  it('persists to the stored user record (listUsers)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await createUserWithEmailAndPassword(auth, 'bob@example.com', 'password123');

    await updateProfile(cred.user, { displayName: 'Bob', photoURL: 'http://example.com/bob.png' });

    const record = authSandbox.listUsers(auth).find((u) => u.uid === cred.user.uid);
    expect(record?.displayName).toBe('Bob');
    expect(record?.photoUrl).toBe('http://example.com/bob.png');
  });

  it('null clears a field; an omitted field is untouched', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await createUserWithEmailAndPassword(auth, 'carol@example.com', 'password123');

    await updateProfile(cred.user, { displayName: 'Carol', photoURL: 'http://example.com/c.png' });
    // Clear displayName only; photoURL omitted → untouched.
    await updateProfile(cred.user, { displayName: null });

    expect(auth.currentUser?.displayName).toBeNull();
    expect(auth.currentUser?.photoURL).toBe('http://example.com/c.png');
  });

  it('works on an anonymous user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await signInAnonymously(auth);

    await updateProfile(cred.user, { displayName: 'Anon', photoURL: 'http://example.com/a.png' });

    expect(auth.currentUser?.displayName).toBe('Anon');
    expect(auth.currentUser?.photoURL).toBe('http://example.com/a.png');
  });

  it('does NOT fire an extra onAuthStateChanged', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const cred = await createUserWithEmailAndPassword(auth, 'dave@example.com', 'password123');

    const seen: (string | null)[] = [];
    const unsub = onAuthStateChanged(auth, (u) => seen.push(u?.uid ?? null));
    await tick(); // initial fire
    const countBefore = seen.length;

    await updateProfile(cred.user, { displayName: 'Dave' });
    await tick();

    expect(seen.length).toBe(countBefore); // no extra fire
    unsub();
  });

  it('throws auth/invalid-user-token for an unrecognized user', async () => {
    const fakeUser = {
      uid: 'x',
      email: null,
      displayName: null,
      isAnonymous: false,
      getIdToken: async () => 'x',
      getIdTokenResult: async () => ({
        token: 'x',
        claims: {},
        expirationTime: '',
        issuedAtTime: '',
        authTime: '',
      }),
    };
    await expect(updateProfile(fakeUser as never, { displayName: 'X' })).rejects.toMatchObject({
      code: 'auth/invalid-user-token',
    });
  });
});
