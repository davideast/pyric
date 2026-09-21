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
import { getAuth, signInAnonymously, signInWithCustomToken, getIdToken, getAdditionalUserInfo,
  createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getFirestore, setDoc, getDoc } from 'firebase/firestore';
const config = { projectId: 'served-token' };
const auth = getAuth(initializeApp(config));
auth.tenantId = 'red';
const otherAuth = getAuth(initializeApp(config, 'other'));
const other = await signInAnonymously(otherAuth);
window.runTokenFlow = async () => {
  const first = await signInWithCustomToken(auth, JSON.stringify({ uid: 'custom-user', claims: { role: 'editor' } }));
  const firstInfo = getAdditionalUserInfo(first);
  const token = await getIdToken(first.user, true);
  const claims = (await first.user.getIdTokenResult()).claims;
  const sameToken = token === await first.user.getIdToken();
  const owned = doc(getFirestore(), 'owned/custom-user');
  await setDoc(owned, { secret: 'owned' });
  const readable = (await getDoc(owned)).data();
  const second = await signInWithCustomToken(auth, JSON.stringify({ uid: 'custom-user', claims: { role: 'reader' } }));
  let denied;
  try { await getDoc(owned); } catch (error) { denied = error.code; }
  let invalid;
  try { await signInWithCustomToken(auth, 'invalid'); } catch (error) { invalid = error.code; }
  const currentAfterInvalid = auth.currentUser.uid;
  const created = await createUserWithEmailAndPassword(auth, 'info@example.com', 'secret-password');
  const existing = await signInWithEmailAndPassword(auth, 'info@example.com', 'secret-password');
  return { firstUid: first.user.uid, firstTenant: first.user.tenantId, claims, firstInfo, sameToken, tokenLength: token.length,
    secondInfo: getAdditionalUserInfo(second), readable, denied, invalid, currentAfterInvalid,
    otherUid: otherAuth.currentUser.uid, originalOtherUid: other.user.uid,
    anonymousInfo: getAdditionalUserInfo(other), createdInfo: getAdditionalUserInfo(created), existingInfo: getAdditionalUserInfo(existing) };
};
document.querySelector('#status').textContent = 'Ready';
`;

for (const hosted of [false, true]) {
  test(`served custom tokens preserve claims, tenant, and credential newness (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-token-')));
    let server: ViteDevServer | undefined;
    try {
      mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
      writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'firestore.rules'), `service cloud.firestore {
        match /databases/{database}/documents { match /owned/{uid} {
          allow read, write: if request.auth.uid == uid && request.auth.token.role == 'editor'
            && request.auth.token.firebase.tenant == 'red';
        } }
      }`);
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
      const result = await page.evaluate(() => Reflect.get(window, 'runTokenFlow')());
      expect(result).toMatchObject({ firstUid: 'custom-user', firstTenant: 'red', sameToken: true,
        claims: { role: 'editor', firebase: { tenant: 'red', sign_in_provider: 'custom' } },
        firstInfo: { isNewUser: true, providerId: null }, secondInfo: { isNewUser: false, providerId: null },
        readable: { secret: 'owned' }, denied: 'permission-denied', invalid: 'auth/invalid-custom-token',
        currentAfterInvalid: 'custom-user', otherUid: result.originalOtherUid,
        anonymousInfo: { isNewUser: true }, createdInfo: { isNewUser: true }, existingInfo: { isNewUser: false },
      });
      expect(result.tokenLength).toBeGreaterThan(0);
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
