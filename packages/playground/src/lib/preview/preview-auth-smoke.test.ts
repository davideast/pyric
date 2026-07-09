/**
 * Preview sign-in smoke — the playground side of the `@pyric/ui/auth`
 * graduation (B1). Simulates exactly what the live preview wires up:
 * a user-authored app's "Sign in with Google" button calls
 * `signInWithPopup` (via the `firebase/auth` → `pyric/auth` alias),
 * the helper (the same `AuthFlowController` the `useAuthFlowHelper`
 * hook installs) parks the request, the user adds an account in the
 * modal, and the app observes the signed-in user.
 *
 * Importing from `@pyric/ui/auth` here also smoke-tests the new
 * subpath's exports-map resolution from a workspace consumer.
 */
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInWithPopup,
  onAuthStateChanged,
  GoogleAuthProvider,
  sandbox as authSandbox,
  type User,
} from 'pyric/auth';
import { AuthFlowController } from '@pyric/ui/auth';

describe('preview sign-in helper smoke', () => {
  test('app Google button → helper add-account → app sees the user', async () => {
    // ── AppPreview wiring: sandbox auth handle + installed helper.
    // Enforcement is DELEGATED exactly as AppPreview does it: the helper is
    // the federated provider, so the picker opens regardless of the
    // sandbox's provider-config defaults (google.com is not enabled by
    // default — without delegation this throws auth/operation-not-allowed
    // before the modal exists). ──
    const auth = getAuth(initializeSandbox());
    authSandbox.delegateProviderEnforcement(auth, true);
    const controller = new AuthFlowController(auth);
    controller.install();

    // ── the user-authored app: subscribes like the prompt teaches ──
    const seen: Array<string | null> = [];
    onAuthStateChanged(auth, (u: User | null) => seen.push(u?.uid ?? null));

    // app's button handler
    const signIn = () => signInWithPopup(auth, new GoogleAuthProvider());

    // ── click: helper modal "opens" (request parks) ──
    const pending = signIn();
    expect(controller.snapshot().request?.providerId).toBe('google.com');

    // ── user fills the add-account form ──
    controller.add({
      email: 'preview@example.com',
      displayName: 'Preview User',
      customClaims: { admin: true },
    });

    const cred = await pending;
    expect(cred.user.email).toBe('preview@example.com');
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    // the app's auth listener observed the sign-in
    expect(seen).toContain(cred.user.uid);
    // claims usable by rules gated on request.auth.token.admin
    expect((await cred.user.getIdTokenResult()).claims.admin).toBe(true);

    controller.uninstall();
  });
});
