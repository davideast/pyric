/** Sign-in helper core (plan step 2.1) — drives the REAL pyric auth SDK
 *  end-to-end, no DOM (the <dialog> shell is browser-gate territory). */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  sandbox as authSandbox,
} from 'pyric/auth';
import { ServeAuthHelper } from '../../src/serve/entries/auth-helper-core.js';

function wire() {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  // These tests exercise the popup/redirect flow via GoogleAuthProvider —
  // enable it up front (the sandbox default is OFF for every provider except
  // password/anonymous — see sandbox.setAuthProviderConfig).
  authSandbox.setAuthProviderConfig(auth, 'google.com', true);
  const helper = new ServeAuthHelper(sandbox);
  helper.install();
  return { auth, helper };
}

describe('ServeAuthHelper', () => {
  it('add → popup resolves, signs in, claims land in the token', async () => {
    const { auth, helper } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    expect(helper.snapshot().request?.providerId).toBe('google.com');
    helper.add({ email: 'new@example.com', displayName: 'New', customClaims: { role: 'admin' } });
    const cred = await p;
    expect(cred.user.email).toBe('new@example.com');
    expect(cred.providerId).toBe('google.com');
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    expect((await cred.user.getIdTokenResult()).claims.role).toBe('admin');
    // seeded → claims visible to rules via the sandbox user DB
    const ids = authSandbox.listIdentities(auth);
    expect(ids.find((i) => i.email === 'new@example.com')?.customClaims).toEqual({ role: 'admin' });
  });

  it('created identity appears in the picker and is pickable next time', async () => {
    const { auth, helper } = wire();
    const p1 = signInWithPopup(auth, new GoogleAuthProvider());
    helper.add({ email: 'a@example.com' });
    await p1;
    const p2 = signInWithPopup(auth, new GoogleAuthProvider());
    const uid = helper.snapshot().identities.find((i) => i.email === 'a@example.com')!.uid;
    helper.pick(uid);
    expect((await p2).user.email).toBe('a@example.com');
  });

  it('cancel rejects auth/popup-closed-by-user; no user set', async () => {
    const { auth, helper } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    helper.cancel();
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(auth.currentUser).toBeNull();
  });

  it('redirect flows through the same helper + getRedirectResult', async () => {
    const { auth, helper } = wire();
    const p = signInWithRedirect(auth, new GoogleAuthProvider());
    helper.add({ email: 'redir@example.com' });
    await p;
    expect((await getRedirectResult(auth))?.user.email).toBe('redir@example.com');
  });

  it('snapshot is referentially stable between emits (view-layer contract)', async () => {
    const { auth, helper } = wire();
    expect(helper.snapshot()).toBe(helper.snapshot());
    const before = helper.snapshot();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    expect(helper.snapshot()).not.toBe(before);
    helper.cancel();
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
  });
});
