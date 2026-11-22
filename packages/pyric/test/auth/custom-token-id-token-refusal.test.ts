/**
 * Regression coverage for #1850: `signInWithCustomToken` refuses minted sandbox
 * ID tokens (`user.getIdToken()`) with `auth/invalid-custom-token` rather than
 * accepting any three-part JWT, both with and without blocking hooks.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
} from '../../src/auth/index.js';
import { mintCustomTokenFor, setAuthBlockingHooks } from '../../src/auth/internal.js';

describe('signInWithCustomToken refuses sandbox ID tokens (#1850)', () => {
  it('refuses an email/password user ID token with auth/invalid-custom-token', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await createUserWithEmailAndPassword(
      auth,
      'idtoken-owner@example.com',
      'pw-123456',
    );
    const idToken = await user.getIdToken();
    await signOut(auth);

    const seenUids: Array<string | null> = [];
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      seenUids.push(u ? u.uid : null);
    });
    await auth.authStateReady();
    seenUids.length = 0;

    await expect(signInWithCustomToken(auth, idToken)).rejects.toMatchObject({
      code: 'auth/invalid-custom-token',
    });
    expect(auth.currentUser).toBeNull();
    expect(seenUids).toEqual([]);
    unsubscribe();
  });

  it('refuses anonymous, custom-token, and federated session ID tokens', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const anon = await signInAnonymously(auth);
    const anonIdToken = await anon.user.getIdToken();
    await signOut(auth);

    const custom = await signInWithCustomToken(
      auth,
      mintCustomTokenFor(auth, 'custom-subject', { role: 'reader' }),
    );
    const customSessionIdToken = await custom.user.getIdToken();
    await signOut(auth);

    const federated = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'fed@example.com', displayName: 'Fed' },
    });
    authSandbox.mockSignInResult(auth, federated);
    const popup = await signInWithPopup(auth, new GoogleAuthProvider());
    const federatedIdToken = await popup.user.getIdToken();
    await signOut(auth);

    for (const idToken of [anonIdToken, customSessionIdToken, federatedIdToken]) {
      await expect(signInWithCustomToken(auth, idToken)).rejects.toMatchObject({
        code: 'auth/invalid-custom-token',
      });
      expect(auth.currentUser).toBeNull();
    }
  });

  it('refuses a sandbox ID token when beforeCreate and beforeSignIn hooks are installed', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await createUserWithEmailAndPassword(
      auth,
      'hooked-idtok@example.com',
      'pw-123456',
    );
    const idToken = await user.getIdToken();
    await signOut(auth);

    let hookCalls = 0;
    setAuthBlockingHooks(auth, {
      beforeCreate: async () => {
        hookCalls += 1;
        return {};
      },
      beforeSignIn: async () => {
        hookCalls += 1;
        return {};
      },
    });

    await expect(signInWithCustomToken(auth, idToken)).rejects.toMatchObject({
      code: 'auth/invalid-custom-token',
    });
    expect(hookCalls).toBe(0);
    expect(auth.currentUser).toBeNull();
  });
});
