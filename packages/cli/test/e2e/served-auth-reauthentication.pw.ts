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
import { getAuth, createUserWithEmailAndPassword, EmailAuthProvider, GoogleAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup, reauthenticateWithRedirect, onAuthStateChanged } from 'firebase/auth';
import { doc, getFirestore, setDoc, getDoc } from 'firebase/firestore';
import { setProviderConfig } from '@pyric/cli/serve/worker';
const config = { projectId: 'served-reauthentication' };
const auth = getAuth(initializeApp(config));
auth.tenantId = 'red';
const { user } = await createUserWithEmailAndPassword(auth, 'owner@example.com', 'secret-password');
const otherAuth = getAuth(initializeApp(config, 'other'));
otherAuth.tenantId = 'blue';
const { user: other } = await createUserWithEmailAndPassword(otherAuth, 'other@example.com', 'other-password');
await setProviderConfig(auth, 'google.com', true);
const owned = doc(getFirestore(), 'owners/' + user.uid);
await setDoc(owned, { uid: user.uid });
const before = await user.getIdTokenResult();
const transitions = [];
onAuthStateChanged(auth, current => transitions.push(current?.uid ?? null));
const credential = EmailAuthProvider.credential('owner@example.com', 'secret-password');
const flows = [];
function resolver(identity) {
  const resolve = async request => { flows.push(request); return { user: identity, providerId: request.providerId }; };
  return { openPopup: resolve, openRedirect: resolve };
}
const actions = {
  correct: () => reauthenticateWithCredential(user, credential),
  wrong: () => reauthenticateWithCredential(user, EmailAuthProvider.credential('owner@example.com', 'wrong-password')),
  mismatch: () => reauthenticateWithCredential(user, EmailAuthProvider.credential('other@example.com', 'other-password')),
  popup: () => reauthenticateWithPopup(user, new GoogleAuthProvider(), resolver(user)),
  redirect: () => reauthenticateWithRedirect(user, new GoogleAuthProvider(), resolver(user)),
  impostor: () => reauthenticateWithPopup(user, new GoogleAuthProvider(), resolver(other)),
};
for (const [name, action] of Object.entries(actions)) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = async () => {
    document.querySelector('#status').textContent = 'Pending';
    try {
      const result = await action();
      const token = await result.user.getIdTokenResult();
      window.reauthProbe = { uid: result.user.uid, originalUid: user.uid, currentUid: auth.currentUser.uid,
        otherUid: otherAuth.currentUser.uid, originalOtherUid: other.uid,
        operation: result.operationType, tenant: result.user.tenantId, claims: token.claims,
        before: before.authTime, after: token.authTime, transitions: [...transitions], flows: [...flows],
        owned: (await getDoc(owned)).data().uid };
      document.querySelector('#status').textContent = 'Success';
    } catch (error) { document.querySelector('#status').textContent = error.code ?? error.message; }
  };
  document.body.append(button);
}
window.initialAuthTime = before.authTime;
document.querySelector('#status').textContent = 'Ready';
`;

for (const hosted of [false, true]) {
  test(`served reauthentication verifies credentials without switching identity (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-reauth-')));
    let server: ViteDevServer | undefined;
    try {
      mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
      writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'firestore.rules'), `service cloud.firestore {
        match /databases/{database}/documents { match /owners/{uid} {
          allow read, write: if request.auth.uid == uid && request.auth.token.firebase.tenant == 'red';
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
      const initialTime = await page.evaluate(() => Date.parse(Reflect.get(window, 'initialAuthTime')));
      // Token timestamps have second precision; cross that boundary before reauth.
      await expect.poll(() => Date.now()).toBeGreaterThan(initialTime + 1100);
      async function action(name: string, expected = 'Success') {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(page.locator('#status')).toHaveText(expected);
      }
      await action('correct');
      const refreshed = await page.evaluate(() => Reflect.get(window, 'reauthProbe'));
      expect(refreshed).toMatchObject({ uid: refreshed.originalUid, currentUid: refreshed.originalUid,
        otherUid: refreshed.originalOtherUid, operation: 'reauthenticate', tenant: 'red', owned: refreshed.originalUid });
      expect(refreshed.claims.firebase.tenant).toBe('red');
      expect(Date.parse(refreshed.after)).toBeGreaterThan(Date.parse(refreshed.before));
      expect(refreshed.transitions).toEqual([refreshed.originalUid]);
      await action('wrong', 'auth/wrong-password');
      await action('mismatch', 'auth/user-mismatch');
      await action('popup');
      await action('redirect');
      const resolved = await page.evaluate(() => Reflect.get(window, 'reauthProbe'));
      expect(resolved.flows).toEqual([
        { providerId: 'google.com', authType: 'reauth' },
        { providerId: 'google.com', authType: 'reauth' },
      ]);
      expect(resolved.uid).toBe(refreshed.originalUid);
      expect(resolved.transitions).toEqual([refreshed.originalUid]);
      await action('impostor', 'auth/user-mismatch');
      await action('correct');
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
