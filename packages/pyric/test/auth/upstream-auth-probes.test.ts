/**
 * Upstream-mined modular Auth probes (series PR 1).
 *
 * Sourced from firebase-js-sdk `packages/auth/test/integration/flows/`
 * against claimed COMPAT rows with thin modular evidence:
 *   A1. `getAdditionalUserInfo` — email create/sign-in + custom-token mint (#171)
 *   A2. `deleteUser` → `reload` → `auth/user-token-expired` (#83)
 *   A3. `updateProfile` survives signOut → signIn (#62 promotion)
 *   A6. `beforeAuthStateChanged` gates `signInWithCustomToken` (#76)
 *
 * ProviderId on password credentials stays `null` (AUTH-B2 / oracle), not
 * upstream's `'password'` — this suite locks the claimed isNewUser matrix.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  beforeAuthStateChanged,
  createUserWithEmailAndPassword,
  deleteUser,
  getAdditionalUserInfo,
  getAuth,
  getIdTokenResult,
  reload,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from '../../src/auth/index.js';

function customToken(uid: string, claims?: Record<string, unknown>): string {
  return JSON.stringify(claims ? { uid, claims } : { uid });
}

describe('A1 getAdditionalUserInfo (upstream auth probes)', () => {
  it('createUserWithEmailAndPassword → isNewUser true', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await createUserWithEmailAndPassword(auth, 'new@example.com', 'password123');
    const info = getAdditionalUserInfo(cred)!;
    expect(info.isNewUser).toBe(true);
    expect(info.providerId).toBeNull();
    expect(info.profile).toEqual({});
  });

  it('signInWithEmailAndPassword → isNewUser false', async () => {
    const auth = getAuth(initializeSandbox());
    await createUserWithEmailAndPassword(auth, 'back@example.com', 'password123');
    await signOut(auth);
    const cred = await signInWithEmailAndPassword(auth, 'back@example.com', 'password123');
    const info = getAdditionalUserInfo(cred)!;
    expect(info.isNewUser).toBe(false);
    expect(info.providerId).toBeNull();
  });

  it('first custom-token sign-in → isNewUser true; return → false', async () => {
    const auth = getAuth(initializeSandbox());
    const first = await signInWithCustomToken(auth, customToken('custom-1', { role: 'admin' }));
    expect(getAdditionalUserInfo(first)!.isNewUser).toBe(true);
    expect(getAdditionalUserInfo(first)!.providerId).toBeNull();
    const claims = (await getIdTokenResult(first.user)).claims;
    expect(claims['role']).toBe('admin');

    await signOut(auth);
    const again = await signInWithCustomToken(auth, customToken('custom-1', { role: 'admin' }));
    expect(getAdditionalUserInfo(again)!.isNewUser).toBe(false);
    expect(getAdditionalUserInfo(again)!.providerId).toBeNull();
  });
});

describe('A2 deleteUser → reload (upstream auth probes)', () => {
  it('reload after deleteUser rejects auth/user-token-expired; currentUser null', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await createUserWithEmailAndPassword(auth, 'gone@example.com', 'password123');
    await deleteUser(user);
    expect(auth.currentUser).toBeNull();
    await expect(reload(user)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });
});

describe('A3 updateProfile persistence (upstream auth probes)', () => {
  it('profile survives signOut → signInWithEmailAndPassword', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await createUserWithEmailAndPassword(auth, 'prof@example.com', 'password123');
    await updateProfile(user, {
      displayName: 'Display Name',
      photoURL: 'https://example.com/photo.png',
    });
    const uid = user.uid;
    await signOut(auth);
    const again = await signInWithEmailAndPassword(auth, 'prof@example.com', 'password123');
    expect(again.user.uid).toBe(uid);
    expect(again.user.displayName).toBe('Display Name');
    expect(again.user.photoURL).toBe('https://example.com/photo.png');
  });
});

describe('A6 beforeAuthStateChanged × custom token (upstream auth probes)', () => {
  it('allowing gate lets signInWithCustomToken commit', async () => {
    const auth = getAuth(initializeSandbox());
    const gated: Array<string | null> = [];
    beforeAuthStateChanged(auth, (u) => {
      gated.push(u?.uid ?? null);
    });
    const cred = await signInWithCustomToken(auth, customToken('gated-ok'));
    expect(gated).toEqual(['gated-ok']);
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
  });

  it('blocking gate aborts custom-token sign-in and keeps prior user', async () => {
    const auth = getAuth(initializeSandbox());
    const prior = await signInWithCustomToken(auth, customToken('prior-user'));
    beforeAuthStateChanged(auth, () => {
      throw new Error('blocked');
    });
    await expect(signInWithCustomToken(auth, customToken('blocked-user'))).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });
    expect(auth.currentUser?.uid).toBe(prior.user.uid);
  });
});
