import { expect, test } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getAuth, onAuthStateChanged, signInWithCustomToken, getAdditionalUserInfo } from '../../../src/auth/index.js';

test('in-page custom-token sign-in transitions global Auth and preserves claim and newness behavior', async () => {
  const auth = getAuth(initializeSandbox());
  const transitions: Array<string | null> = [];
  const stop = onAuthStateChanged(auth, user => transitions.push(user?.uid ?? null));
  try {
    for (const isNewUser of [true, false]) {
      const credential = await signInWithCustomToken(auth, JSON.stringify({ uid: 'custom-user', claims: { editor: isNewUser } }));
      expect(auth.currentUser).toBe(credential.user);
      expect(credential.providerId).toBeNull();
      expect(getAdditionalUserInfo(credential)?.isNewUser).toBe(isNewUser);
      expect(await credential.user.getIdTokenResult()).toMatchObject({ claims: { editor: isNewUser,
        firebase: { sign_in_provider: 'custom' } } });
      expect(transitions.at(-1)).toBe('custom-user');
    }
    const current = auth.currentUser;
    await expect(signInWithCustomToken(auth, 'invalid')).rejects.toMatchObject({ code: 'auth/invalid-custom-token' });
    expect(auth.currentUser).toBe(current);
  } finally { stop(); }
});
