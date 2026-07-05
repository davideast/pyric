/** Sign-in helper controller — the testable core behind the helper UI.
 *  Runs against a real sandbox; no DOM. (Moved from
 *  examples/playground-next/src/lib/preview/auth-flow-controller.test.ts
 *  when the controller graduated into `@pyric/ui/auth`.) */
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  sandbox as authSandbox,
} from 'pyric/auth';
import { AuthFlowController } from '../../../src/auth/index.js';

function wire() {
  const auth = getAuth(initializeSandbox());
  const controller = new AuthFlowController(auth);
  // inject so signInWithPopup delegates here
  authSandbox.setAuthFlowResolver(auth, controller.resolver());
  return { auth, controller };
}

describe('AuthFlowController', () => {
  test('add new account → signInWithPopup resolves with that identity + signs in', async () => {
    const { auth, controller } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    // helper UI would render here; simulate the user filling the add-account form
    controller.add({ email: 'new@example.com', displayName: 'New', customClaims: { role: 'admin' } });
    const cred = await p;
    expect(cred.user.email).toBe('new@example.com');
    expect(cred.providerId).toBe('google.com');
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    // claims flow into the app-facing token
    expect((await cred.user.getIdTokenResult()).claims.role).toBe('admin');
  });

  test('the created identity then appears in the picker and is pickable', async () => {
    const { auth, controller } = wire();
    const p1 = signInWithPopup(auth, new GoogleAuthProvider());
    controller.add({ email: 'a@example.com' });
    await p1;
    expect(controller.snapshot().identities.some((i) => i.email === 'a@example.com')).toBe(true);

    const p2 = signInWithPopup(auth, new GoogleAuthProvider());
    const uid = controller.snapshot().identities.find((i) => i.email === 'a@example.com')!.uid;
    controller.pick(uid);
    const cred = await p2;
    expect(cred.user.email).toBe('a@example.com');
  });

  test('cancel rejects with auth/popup-closed-by-user; no user set', async () => {
    const { auth, controller } = wire();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    controller.cancel();
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(auth.currentUser).toBeNull();
  });

  test('redirect flow drives the same controller', async () => {
    const { auth, controller } = wire();
    const p = signInWithRedirect(auth, new GoogleAuthProvider());
    controller.add({ email: 'redir@example.com' });
    await p;
    const result = await getRedirectResult(auth);
    expect(result?.user.email).toBe('redir@example.com');
  });

  test('snapshot.request reflects the in-flight popup, null when settled', async () => {
    const { auth, controller } = wire();
    expect(controller.snapshot().request).toBeNull();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    expect(controller.snapshot().request?.providerId).toBe('google.com');
    controller.add({ email: 'x@example.com' });
    await p;
    expect(controller.snapshot().request).toBeNull();
  });

  test('snapshot is referentially stable between emits (useSyncExternalStore contract)', async () => {
    const { auth, controller } = wire();
    // Same reference until the store actually changes — an uncached snapshot
    // makes useSyncExternalStore re-render in an infinite loop.
    expect(controller.snapshot()).toBe(controller.snapshot());
    const before = controller.snapshot();
    const p = signInWithPopup(auth, new GoogleAuthProvider()); // → emit
    const during = controller.snapshot();
    expect(during).not.toBe(before);
    expect(controller.snapshot()).toBe(during);
    controller.cancel(); // → emit
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(controller.snapshot()).not.toBe(during);
    expect(controller.snapshot()).toBe(controller.snapshot());
  });

  test('install/uninstall wire and clear the resolver on the auth handle', async () => {
    const auth = getAuth(initializeSandbox());
    const controller = new AuthFlowController(auth);
    controller.install();
    const p = signInWithPopup(auth, new GoogleAuthProvider());
    expect(controller.snapshot().request?.providerId).toBe('google.com');
    controller.cancel();
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    controller.uninstall();
    // With the resolver cleared, the SDK falls back to its faithful default.
    await expect(signInWithPopup(auth, new GoogleAuthProvider())).rejects.toMatchObject({
      code: 'auth/argument-error',
    });
  });
});
