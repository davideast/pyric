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
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut,
  linkWithPopup, linkWithRedirect, linkWithCredential, unlink,
  GoogleAuthProvider, GithubAuthProvider, EmailAuthProvider, onAuthStateChanged } from 'firebase/auth';
import { doc, getFirestore, setDoc, getDoc } from 'firebase/firestore';
import { setProviderConfig } from '@pyric/cli/serve/worker';
const auth = getAuth(initializeApp({ projectId: 'served-linking' }));
auth.tenantId = 'red';
await setProviderConfig(auth, 'google.com', true);
await setProviderConfig(auth, 'github.com', true);
const { user: original } = await signInAnonymously(auth);
const owned = doc(getFirestore(), 'owners/' + original.uid);
await setDoc(owned, { owner: original.uid });
const transitions = [];
const stop = onAuthStateChanged(auth, user => transitions.push(user?.uid ?? null));
const password = EmailAuthProvider.credential('linked@example.com', 'secret-password');
const actions = {
  popup: () => linkWithPopup(original, new GoogleAuthProvider()),
  duplicate: () => linkWithCredential(auth.currentUser, GoogleAuthProvider.credential('demo')),
  password: () => linkWithCredential(auth.currentUser, password),
  signin: async () => { await signOut(auth); return signInWithEmailAndPassword(auth, 'linked@example.com', 'secret-password'); },
  unlink: () => unlink(auth.currentUser, 'password'),
  missing: () => unlink(auth.currentUser, 'password'),
  redirect: () => linkWithRedirect(auth.currentUser, new GithubAuthProvider(), {
    openRedirect: async request => { window.flowRequest = request; return { user: auth.currentUser, providerId: request.providerId }; },
  }),
  stale: async () => { await signInAnonymously(auth); return linkWithCredential(original, password); },
};
for (const [name, action] of Object.entries(actions)) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = async () => {
    document.querySelector('#status').textContent = 'Pending';
    try {
      const result = await action();
      const user = result.user ?? result;
      const token = await user.getIdTokenResult();
      window.linkProbe = { uid: user.uid, originalUid: original.uid, currentUid: auth.currentUser.uid,
        providers: user.providerData.map(p => p.providerId), currentProviders: auth.currentUser.providerData.map(p => p.providerId),
        anonymous: user.isAnonymous, tenant: user.tenantId, provider: token.signInProvider,
        operation: result.operationType, owned: (await getDoc(owned)).data().owner, transitions };
      document.querySelector('#status').textContent = 'Success';
    } catch (error) { document.querySelector('#status').textContent = error.code ?? error.message; }
  };
  document.body.append(button);
}
document.querySelector('#status').textContent = 'Ready';
`;

for (const hosted of [false, true]) {
  test(`served linking preserves the anonymous identity (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-linking-')));
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
      await page.getByRole('button', { name: 'popup', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('Pending');
      const dialog = page.locator('dialog[data-pyric-auth][open]');
      await expect(dialog).toBeVisible();
      await dialog.locator('input[type="email"]').fill('provider@example.com');
      await dialog.locator('button.submit').click();
      await expect(page.locator('#status')).toHaveText('Success');
      const linked = await page.evaluate(() => Reflect.get(window, 'linkProbe'));
      expect(linked).toMatchObject({ uid: linked.originalUid, currentUid: linked.originalUid,
        providers: ['google.com'], currentProviders: ['google.com'], anonymous: false,
        tenant: 'red', provider: 'google.com', operation: 'link', owned: linked.originalUid });
      expect(linked.transitions).toEqual([linked.originalUid]);
      async function action(name: string, expected = 'Success') {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(page.locator('#status')).toHaveText(expected);
      }
      await action('duplicate', 'auth/provider-already-linked');
      await action('password');
      await action('signin');
      const signedIn = await page.evaluate(() => Reflect.get(window, 'linkProbe'));
      expect(signedIn.uid).toBe(linked.originalUid);
      expect(signedIn.providers).toEqual(['google.com', 'password']);
      await action('unlink');
      const unlinked = await page.evaluate(() => Reflect.get(window, 'linkProbe'));
      expect(unlinked.providers).toEqual(['google.com']);
      expect(unlinked.currentProviders).toEqual(['google.com']);
      await action('missing', 'auth/no-such-provider');
      await action('redirect');
      expect(await page.evaluate(() => Reflect.get(window, 'flowRequest'))).toEqual({ providerId: 'github.com', authType: 'link' });
      await action('stale', 'auth/user-mismatch');
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
