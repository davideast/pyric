/**
 * The recent-login gate. Production refuses a sensitive account operation on
 * a session whose last authentication is older than five minutes, with
 * `auth/requires-recent-login`, and a re-authentication clears it. The
 * sandbox measures that age on the sandbox clock, so a test reaches the gate
 * by advancing the clock. Behavior pinned against the oracle capture
 * `auth-requires-recent-login`.
 */

import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  linkWithCredential,
  reauthenticateWithCredential,
  signInAnonymously,
  signInWithEmailAndPassword,
  unlink,
  updateEmail,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  type Auth,
} from '../../src/auth/index.js';
import type { Sandbox } from 'pyric/sandbox';

const PASSWORD = 'pw-123456';
const SECONDS = 1000;

function fresh(): { sandbox: Sandbox; auth: Auth } {
  const sandbox = initializeSandbox();
  return { sandbox, auth: getAuth(sandbox) };
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { code: string; message: string };
    return { code: err.code, message: err.message };
  }
}

describe('auth/requires-recent-login', () => {
  it('lets a sensitive operation run right after sign-in', async () => {
    const { auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'fresh@example.com', PASSWORD);
    expect(await rejection(updatePassword(user, 'pw-fresh-1'))).toBeNull();
  });

  it('refuses every gated operation once the session is older than five minutes', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'stale@example.com', PASSWORD);
    getClock(sandbox).advance(305 * SECONDS);

    const expected = {
      code: 'auth/requires-recent-login',
      message: 'Firebase: Error (auth/requires-recent-login).',
    };
    expect(await rejection(updatePassword(user, 'pw-stale-1'))).toEqual(expected);
    expect(await rejection(updateEmail(user, 'moved@example.com'))).toEqual(expected);
    expect(await rejection(verifyBeforeUpdateEmail(user, 'moved@example.com'))).toEqual(expected);
    expect(await rejection(deleteUser(user))).toEqual(expected);

    // Nothing changed: the old password still signs in, as the same account.
    const again = await signInWithEmailAndPassword(auth, 'stale@example.com', PASSWORD);
    expect(again.user.uid).toBe(user.uid);
    expect(again.user.email).toBe('stale@example.com');
  });

  it('leaves unlink, profile writes, and token refresh alone on a stale session', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'profile@example.com', PASSWORD);
    getClock(sandbox).advance(330 * SECONDS);
    expect(await rejection(updateProfile(user, { displayName: 'still fine' }))).toBeNull();
    expect(await rejection(user.getIdToken(true))).toBeNull();
    expect(await rejection(unlink(user, 'password'))).toBeNull();
  });

  it('does not gate an anonymous account: linking and deletion both run', async () => {
    const { sandbox, auth } = fresh();
    const linking = await signInAnonymously(auth);
    getClock(sandbox).advance(330 * SECONDS);
    const credential = EmailAuthProvider.credential('link@example.com', PASSWORD);
    expect(await rejection(linkWithCredential(linking.user, credential))).toBeNull();

    const { sandbox: other, auth: otherAuth } = fresh();
    const deleting = await signInAnonymously(otherAuth);
    getClock(other).advance(330 * SECONDS);
    expect(await rejection(deleteUser(deleting.user))).toBeNull();
  });

  it('still allows the operation inside the window', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'inside@example.com', PASSWORD);
    getClock(sandbox).advance(295 * SECONDS);
    expect(await rejection(deleteUser(user))).toBeNull();
  });

  it('is not reset by a forced token refresh, which keeps auth_time', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'refresh@example.com', PASSWORD);
    const signedIn = await user.getIdTokenResult();
    getClock(sandbox).advance(120 * SECONDS);
    const refreshed = await user.getIdTokenResult(true);
    expect(refreshed.authTime).toBe(signedIn.authTime);
    expect(refreshed.issuedAtTime).not.toBe(signedIn.issuedAtTime);

    getClock(sandbox).advance(210 * SECONDS);
    expect((await rejection(updatePassword(user, 'pw-refresh-1')))?.code).toBe('auth/requires-recent-login');
  });

  it('is cleared by reauthenticateWithCredential', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'reauth@example.com', PASSWORD);
    getClock(sandbox).advance(330 * SECONDS);
    expect((await rejection(updatePassword(user, 'pw-reauth-1')))?.code).toBe('auth/requires-recent-login');

    await reauthenticateWithCredential(user, EmailAuthProvider.credential('reauth@example.com', PASSWORD));
    expect(await rejection(updatePassword(user, 'pw-reauth-1'))).toBeNull();
    expect(await rejection(deleteUser(user))).toBeNull();
  });

  it('is cleared by signing in again', async () => {
    const { sandbox, auth } = fresh();
    const { user } = await createUserWithEmailAndPassword(auth, 'again@example.com', PASSWORD);
    getClock(sandbox).advance(330 * SECONDS);
    const again = await signInWithEmailAndPassword(auth, 'again@example.com', PASSWORD);
    expect(again.user.uid).toBe(user.uid);
    expect(await rejection(deleteUser(again.user))).toBeNull();
  });
});
