import { expect, test } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getAuth, onAuthStateChanged, sandbox, sendSignInLinkToEmail, signInWithEmailLink,
  getAdditionalUserInfo } from '../../../src/auth/index.js';

test('in-page email-link redemption transitions global Auth and reports newness', async () => {
  const auth = getAuth(initializeSandbox());
  const transitions: Array<string | null> = [];
  const stop = onAuthStateChanged(auth, user => transitions.push(user?.uid ?? null));
  try {
    await Promise.resolve();
    for (const isNewUser of [true, false]) {
      await sendSignInLinkToEmail(auth, 'owner@example.com', { url: 'https://example.com', handleCodeInApp: true });
      const mail = sandbox.takeAuthMail(auth);
      expect(mail).not.toBeNull();
      const credential = await signInWithEmailLink(auth, 'owner@example.com', mail!.link);
      expect(auth.currentUser).toBe(credential.user);
      expect(credential.user.emailVerified).toBe(true);
      expect(credential.providerId).toBeNull();
      expect(getAdditionalUserInfo(credential)?.isNewUser).toBe(isNewUser);
      expect(transitions.at(-1)).toBe(credential.user.uid);
    }
  } finally { stop(); }
});
