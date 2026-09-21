import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const app = `
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  sendEmailVerification, checkActionCode, applyActionCode, reload, verifyBeforeUpdateEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink } from 'firebase/auth';
import { takeAuthMail } from '@pyric/cli/serve/worker';
const config = { projectId: 'served-email' };
const auth = getAuth(initializeApp(config));
auth.tenantId = 'red';
const { user } = await createUserWithEmailAndPassword(auth, 'owner@example.com', 'secret-password');
const otherAuth = getAuth(initializeApp(config, 'other'));
const { user: other } = await createUserWithEmailAndPassword(otherAuth, 'other@example.com', 'other-password');
async function errorCode(action) {
  try { await action(); return 'unexpected-success'; } catch (error) { return error.code; }
}
window.runEmailFlows = async () => {
  await sendPasswordResetEmail(auth, user.email);
  // The sandbox mailbox is shared: another attached app can consume its mail.
  const reset = await takeAuthMail(otherAuth, user.email);
  const empty = await takeAuthMail(auth, user.email);
  const email = await verifyPasswordResetCode(auth, reset.code);
  const weakPassword = await errorCode(() => confirmPasswordReset(auth, reset.code, 'bad'));
  await confirmPasswordReset(auth, reset.code, 'changed-password');
  const replay = await errorCode(() => confirmPasswordReset(auth, reset.code, 'another-password'));
  await signOut(auth);
  const oldPassword = await errorCode(() => signInWithEmailAndPassword(auth, user.email, 'secret-password'));
  const { user: returned } = await signInWithEmailAndPassword(auth, user.email, 'changed-password');
  await sendEmailVerification(returned);
  const verification = await takeAuthMail(auth, user.email);
  const verificationInfo = await checkActionCode(auth, verification.code);
  await applyActionCode(auth, verification.code);
  await reload(returned);
  const verified = returned.emailVerified;
  await verifyBeforeUpdateEmail(returned, 'changed@example.com');
  const change = await takeAuthMail(auth, 'changed@example.com');
  const originalEmail = returned.email;
  await applyActionCode(auth, change.code);
  await reload(returned);
  await sendSignInLinkToEmail(auth, 'link@example.com', { url: location.origin, handleCodeInApp: true });
  const mail = await takeAuthMail(auth, 'link@example.com');
  const predicate = [isSignInWithEmailLink(auth, mail.link), isSignInWithEmailLink(auth, reset.link),
    isSignInWithEmailLink(auth, 'garbage')];
  const wrongEmail = await errorCode(() => signInWithEmailLink(auth, 'wrong@example.com', mail.link));
  const linked = await signInWithEmailLink(auth, 'link@example.com', mail.link);
  const linkReplay = await errorCode(() => signInWithEmailLink(auth, 'link@example.com', mail.link));
  const claims = (await linked.user.getIdTokenResult()).claims;
  return { uid: user.uid, returnedUid: returned.uid, email, empty, weakPassword, replay, oldPassword,
    verified, verificationOperation: verificationInfo.operation, originalEmail, changedEmail: returned.email,
    predicate, wrongEmail, linkReplay, linkedEmail: linked.user.email, linkedVerified: linked.user.emailVerified,
    linkedTenant: linked.user.tenantId, tenantClaim: claims.firebase.tenant,
    currentUid: auth.currentUser.uid, linkedUid: linked.user.uid, otherUid: otherAuth.currentUser.uid, originalOtherUid: other.uid };
};
document.querySelector('#status').textContent = 'Ready';
`;

for (const hosted of [false, true]) {
  test(`served email flows redeem real outbox codes (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-email-')));
    let server: ViteDevServer | undefined;
    try {
      mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
      writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      server = await createServer({ root, configFile: false, logLevel: 'silent',
        plugins: [pyric({ hosted, capture: false, ui: false })],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
      });
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      const missingUrl = url === undefined;
      if (missingUrl) throw new Error('Vite did not expose a URL');
      await page.goto(url);
      await expect(page.locator('#status')).toHaveText('Ready');
      const result = await page.evaluate(() => Reflect.get(window, 'runEmailFlows')());
      expect(result).toMatchObject({ returnedUid: result.uid, email: 'owner@example.com', empty: null,
        weakPassword: 'auth/weak-password', replay: 'auth/invalid-action-code', oldPassword: 'auth/wrong-password',
        verified: true, verificationOperation: 'VERIFY_EMAIL', originalEmail: 'owner@example.com', changedEmail: 'changed@example.com',
        predicate: [true, false, false], wrongEmail: 'auth/invalid-email', linkReplay: 'auth/invalid-action-code',
        linkedEmail: 'link@example.com', linkedVerified: true, linkedTenant: 'red', tenantClaim: 'red',
        currentUid: result.linkedUid, otherUid: result.originalOtherUid,
      });
      expect(result.linkedUid).not.toBe(result.uid);
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
