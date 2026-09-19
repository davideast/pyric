import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

const cliDir = fileURLToPath(new URL('../../../', import.meta.url));
const app = `
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, signOut, updatePassword, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { setProviderConfig } from '@pyric/cli/serve/worker';
const auth = getAuth(initializeApp({ apiKey: 'demo', projectId: 'auth-preservation' }));
auth.tenantId = 'red';
await setProviderConfig(auth, 'google.com', true);
const status = document.querySelector('#status');
const actions = {
  create: () => createUserWithEmailAndPassword(auth, 'linked@example.com', 'original-password'),
  original: () => signInWithEmailAndPassword(auth, 'linked@example.com', 'original-password'),
  changed: () => signInWithEmailAndPassword(auth, 'linked@example.com', 'changed-password'),
  change: () => updatePassword(auth.currentUser, 'changed-password'),
  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signout: () => signOut(auth),
  red: () => setDoc(doc(getFirestore(), 'tenants/red/notes/test'), { message: 'allowed' }),
  blue: () => setDoc(doc(getFirestore(), 'tenants/blue/notes/test'), { message: 'denied' }),
};
for (const [name, action] of Object.entries(actions)) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = async () => {
    status.textContent = 'Pending';
    try {
      await action();
      const user = auth.currentUser;
      const token = user ? await user.getIdTokenResult() : null;
      document.querySelector('#providers').textContent = user?.providerData.map(p => p.providerId).join(',') ?? '';
      document.querySelector('#provider').textContent = token?.signInProvider ?? '';
      status.textContent = 'Success';
    } catch (error) { status.textContent = error.code; }
  };
  document.body.append(button);
}
status.textContent = 'Ready';
`;

for (const hosted of [true, false]) {
  test(`password and linked providers survive provider sign-in and restart (${hosted ? 'Node' : 'SharedWorker'})`, async ({ browser }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-auth-preservation-')));
    let server: ViteDevServer | undefined;
    let context = await browser.newContext();
    async function start() {
      server = await createServer({
        root, configFile: false, logLevel: 'silent',
        plugins: [pyric({ hosted, persist: true, capture: false, ui: false })],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
      });
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) throw new Error('Vite did not listen.');
      const page = await context.newPage();
      await page.goto(url);
      await expect(page.locator('#status')).toHaveText('Ready');
      return page;
    }
    try {
      mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
      writeFileSync(join(root, 'index.html'), '<html><head></head><body><output id="status">Starting</output><output id="providers"></output><output id="provider"></output><script type="module" src="/main.js"></script></body></html>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'firestore.rules'), `service cloud.firestore {
        match /databases/{db}/documents { match /tenants/{tenant}/notes/{id} {
          allow read, write: if request.auth != null && request.auth.token.firebase.tenant == tenant;
        } }
      }`);
      let page = await start();
      async function action(name: string, result = 'Success') {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(page.locator('#status')).toHaveText(result);
      }
      async function google() {
        await page.getByRole('button', { name: 'google', exact: true }).click();
        const dialog = page.locator('dialog[data-pyric-auth][open]');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'linked@example.com', exact: true }).click();
        await expect(page.locator('#status')).toHaveText('Success');
        await expect(page.locator('#provider')).toHaveText('google.com');
        await expect(page.locator('#providers')).toHaveText('password,google.com');
      }
      await action('create');
      await google();
      await action('original');
      await action('change');
      await google();
      await action('red');
      await action('blue', 'permission-denied');
      await action('signout');
      await action('original', 'auth/wrong-password');
      await action('changed');
      await context.close();
      await server?.close();
      context = await browser.newContext();
      page = await start();
      await action('changed');
      await expect(page.locator('#providers')).toHaveText('password,google.com');
      await google();
      await action('red');
      await action('blue', 'permission-denied');
      await action('signout');
      await action('original', 'auth/wrong-password');
    } finally {
      await context.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
