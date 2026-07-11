/**
 * Low-hanging-fruit `firebase/auth` exports (issue #149).
 *
 * Each test proves (a) the symbol is now importable (was a missing export —
 * an app importing it crashed at module load before this landed) and (b) its
 * contract: the real-behavior functions actually mutate/read the sandbox
 * user store; the no-op functions resolve without error.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  initializeAuth,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  signOut,
  deleteUser,
  updateEmail,
  updatePassword,
  reload,
  updateCurrentUser,
  useDeviceLanguage,
} from '../../src/auth/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  authSandbox.seedUsers(auth, [
    { uid: 'alice', email: 'alice@example.com', password: 'pw-original', displayName: 'Alice' },
  ]);
  return { sandbox, auth };
}

describe('Auth low-hanging-fruit exports (issue #149)', () => {
  it('all seven symbols are importable (were missing exports before)', () => {
    for (const fn of [
      initializeAuth, deleteUser, updateEmail, updatePassword, reload, updateCurrentUser, useDeviceLanguage,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('initializeAuth aliases getAuth — same instance, live currentUser', async () => {
    const sandbox = initializeSandbox();
    const viaInit = initializeAuth(sandbox);
    const viaGet = getAuth(sandbox);
    expect(viaInit).toBe(viaGet);
    // The Dependencies arg is accepted for parity.
    expect(initializeAuth(sandbox, { persistence: [] })).toBe(viaGet);

    authSandbox.seedUsers(viaInit, [{ uid: 'bob', email: 'bob@example.com', password: 'pw' }]);
    await signInWithEmailAndPassword(viaInit, 'bob@example.com', 'pw');
    expect(viaInit.currentUser?.uid).toBe('bob');
  });

  it('deleteUser removes the account from the store and signs the user out', async () => {
    const { auth } = setup();
    const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original');
    expect(auth.currentUser?.uid).toBe('alice');

    await deleteUser(user);
    expect(auth.currentUser).toBeNull();
    // The identity is gone: re-sign-in throws user-not-found.
    await expect(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original'),
    ).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('updateEmail changes the stored email (next sign-in uses the new one)', async () => {
    const { auth } = setup();
    const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original');

    await updateEmail(user, 'alice2@example.com');
    expect(auth.currentUser?.email).toBe('alice2@example.com');

    await signOut(auth);
    // Old email no longer resolves; new one does.
    await expect(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original'),
    ).rejects.toMatchObject({ code: 'auth/user-not-found' });
    const again = await signInWithEmailAndPassword(auth, 'alice2@example.com', 'pw-original');
    expect(again.user.uid).toBe('alice');
  });

  it('updatePassword sets a stored+verified password', async () => {
    const { auth } = setup();
    const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original');

    await updatePassword(user, 'pw-brand-new');
    await signOut(auth);

    // New password signs in; the old one is rejected — the sandbox really
    // verifies passwords.
    const ok = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-brand-new');
    expect(ok.user.uid).toBe('alice');
    await signOut(auth);
    await expect(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original'),
    ).rejects.toMatchObject({ code: 'auth/wrong-password' });
  });

  it('reload re-reads the stored record into the held user', async () => {
    const { auth } = setup();
    const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original');
    expect(user.displayName).toBe('Alice');

    // Change the record out of band, then reload.
    authSandbox.updateUser(auth, 'alice', { displayName: 'Alice Renamed' });
    expect(user.displayName).toBe('Alice'); // not yet reflected
    await reload(user);
    expect(user.displayName).toBe('Alice Renamed');
  });

  it('updateCurrentUser sets (and clears) the current user', async () => {
    const { auth } = setup();
    const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw-original');

    await updateCurrentUser(auth, null);
    expect(auth.currentUser).toBeNull();

    await updateCurrentUser(auth, user);
    expect(auth.currentUser?.uid).toBe('alice');
  });

  it('useDeviceLanguage is an accepted no-op', () => {
    const { auth } = setup();
    expect(() => useDeviceLanguage(auth)).not.toThrow();
  });
});
