import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { get, getDatabase, ref, set } from 'pyric/database';
import { setRules } from 'pyric/sandbox/database';
import {
  createUserWithEmailAndPassword, getAuth, sandbox as authSandbox,
  sendSignInLinkToEmail, signInWithEmailAndPassword, signInWithEmailLink, signOut,
} from '../../src/auth/index.js';

for (const flow of ['password', 'email-link']) {
  test(`${flow} signup returns an identity usable in owner-scoped RTDB paths`, async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      const database = getDatabase(sandbox);
      setRules(sandbox, { rules: { presence: { $uid: {
        '.read': 'auth != null && auth.uid == $uid',
        '.write': 'auth != null && auth.uid == $uid',
      } } } });
      const email = 'first.last@example.test';
      const password = 'checkpoint-password';
      async function signIn() {
        const usesPassword = flow === 'password';
        if (usesPassword) return signInWithEmailAndPassword(auth, email, password);
        await sendSignInLinkToEmail(auth, email, { url: 'https://example.test/signin', handleCodeInApp: true });
        const mail = authSandbox.takeAuthMail(auth);
        const missingMail = mail === null;
        if (missingMail) throw new Error('Expected a sign-in link.');
        return signInWithEmailLink(auth, email, mail.link);
      }
      const usesPassword = flow === 'password';
      const credential = usesPassword
        ? await createUserWithEmailAndPassword(auth, email, password)
        : await signIn();
      const uid = credential.user.uid;
      const ownPresence = ref(database, `presence/${uid}`);
      await set(ownPresence, 'online');
      expect((await get(ownPresence)).val()).toBe('online');
      await expect(set(ref(database, 'presence/another-user'), 'online')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await signOut(auth);
      await expect(get(ownPresence)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((await signIn()).user.uid).toBe(uid);
      expect((await get(ownPresence)).val()).toBe('online');
    } finally { sandbox.dispose(); }
  });
}
