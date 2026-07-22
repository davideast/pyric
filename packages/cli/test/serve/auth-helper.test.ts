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

/** Mirror served in-page wiring: mint via createSignInCredential. */
function helperForLocalAuth(auth: ReturnType<typeof getAuth>): ServeAuthHelper {
  const helper = new ServeAuthHelper(
    {
      list: () => authSandbox.listIdentities(auth),
    },
    (request) => {
      if (request.kind === 'pick') {
        return authSandbox.createSignInCredential(auth, {
          providerId: request.providerId,
          uid: request.identity.uid,
        });
      }
      return authSandbox.createSignInCredential(auth, {
        providerId: request.providerId,
        spec: {
          email: request.spec.email,
          displayName: request.spec.displayName,
          customClaims: request.spec.customClaims,
        },
      });
    },
  );
  authSandbox.setAuthFlowResolver(auth, helper.resolver());
  return helper;
}

function wire() {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  // Mirror the REAL served worker-mode wiring (entries/auth.ts): the
  // page-local sandbox the helper drives is a UI vehicle — its provider gate
  // is delegated to the worker authority, so the picker opens for providers
  // the page's own defaults (password/anonymous only) would otherwise veto.
  // Enforcement in served mode happens at the worker's `auth.acceptIdentity`
  // (covered in test/serve/worker/auth.test.ts).
  authSandbox.delegateProviderEnforcement(auth, true);
  const helper = helperForLocalAuth(auth);
  return { auth, helper };
}

function expectGoogleProviderMetadata(
  user: NonNullable<ReturnType<typeof getAuth>['currentUser']>,
  identityProviderId = 'google.com',
): void {
  expect(user.providerId).toBe('firebase');
  expect(user.providerData?.map((p) => p.providerId)).toContain(identityProviderId);
}

describe('ServeAuthHelper', () => {
  it('resolves a worker-provided identity without constructing a page Sandbox/Auth backend', async () => {
    const helper = new ServeAuthHelper({
      list: () => [{
        uid: 'google.com:worker@example.com',
        email: 'worker@example.com',
        displayName: 'Worker User',
        customClaims: { role: 'reviewer' },
      }],
    });
    const pending = helper.resolver().openPopup({
      providerId: 'google.com',
      authType: 'signIn',
    });

    helper.pick('google.com:worker@example.com');

    await expect(pending).resolves.toMatchObject({
      providerId: 'google.com',
      user: {
        uid: 'google.com:worker@example.com',
        email: 'worker@example.com',
        providerId: 'firebase',
        providerData: [{ providerId: 'google.com' }],
      },
    });
    const cred = await pending;
    expect((await cred.user.getIdTokenResult()).signInProvider).toBe('google.com');
  });

  it('non-delegated (in-page fallback): a disabled google.com popup throws operation-not-allowed', async () => {
    // The served NON-worker leg keeps local gating with the documented
    // sandbox defaults (everything enabled) — an explicit disable still bites.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    const helper = helperForLocalAuth(auth);
    await expect(signInWithPopup(auth, new GoogleAuthProvider())).rejects.toMatchObject({
      code: 'auth/operation-not-allowed',
    });
    expect(helper.snapshot().request).toBeNull(); // gate fires before the picker opens
  });

  it('add → popup resolves, signs in, claims land in the token', async () => {
    const { auth, helper } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    expect(helper.snapshot().request?.providerId).toBe('google.com');
    helper.add({ email: 'new@example.com', displayName: 'New', customClaims: { role: 'admin' } });
    const cred = await p;
    expect(cred.user.email).toBe('new@example.com');
    expect(cred.providerId).toBe('google.com');
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    expectGoogleProviderMetadata(cred.user);
    expectGoogleProviderMetadata(auth.currentUser!);
    const token = await cred.user.getIdTokenResult();
    expect(token.claims.role).toBe('admin');
    expect(token.signInProvider).toBe('google.com');
    expect(
      (token.claims as { firebase?: { sign_in_provider?: string } }).firebase?.sign_in_provider,
    ).toBe('google.com');
    // seeded → claims visible to rules via the sandbox user DB
    const ids = authSandbox.listIdentities(auth);
    const created = ids.find((i) => i.email === 'new@example.com');
    expect(created?.customClaims).toEqual({ role: 'admin' });
    expect(created?.providerId).toBe('google.com');
    expect(created?.providerUserInfo.map((p) => p.providerId)).toEqual(['google.com']);
  });

  it('created identity appears in the picker and is pickable next time with Google metadata', async () => {
    const { auth, helper } = wire();
    const p1 = signInWithPopup(auth, new GoogleAuthProvider());
    helper.add({ email: 'a@example.com' });
    await p1;
    const p2 = signInWithPopup(auth, new GoogleAuthProvider());
    const uid = helper.snapshot().identities.find((i) => i.email === 'a@example.com')!.uid;
    helper.pick(uid);
    const cred = await p2;
    expect(cred.user.email).toBe('a@example.com');
    expectGoogleProviderMetadata(cred.user);
    expectGoogleProviderMetadata(auth.currentUser!);
    expect((await cred.user.getIdTokenResult()).signInProvider).toBe('google.com');
    expect(authSandbox.listIdentities(auth).find((i) => i.uid === uid)?.providerId).toBe(
      'google.com',
    );
  });

  it('cancel rejects auth/popup-closed-by-user; no user set', async () => {
    const { auth, helper } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    helper.cancel();
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(auth.currentUser).toBeNull();
  });

  it('redirect flows through the same helper + getRedirectResult with Google metadata', async () => {
    const { auth, helper } = wire();
    const p = signInWithRedirect(auth, new GoogleAuthProvider());
    helper.add({ email: 'redir@example.com' });
    await p;
    const result = await getRedirectResult(auth);
    expect(result?.user.email).toBe('redir@example.com');
    expectGoogleProviderMetadata(result!.user);
    expectGoogleProviderMetadata(auth.currentUser!);
    expect((await result!.user.getIdTokenResult()).signInProvider).toBe('google.com');
    expect(
      authSandbox.listIdentities(auth).find((i) => i.email === 'redir@example.com')?.providerId,
    ).toBe('google.com');
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
