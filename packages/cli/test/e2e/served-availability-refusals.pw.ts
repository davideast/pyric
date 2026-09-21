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
import { getAuth, beforeAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { getStorage, ref, uploadBytes, updateMetadata, getMetadata } from 'firebase/storage';
initializeApp({ projectId: 'served-availability', storageBucket: 'served-availability' });
window.verifyAvailability = async (inPage) => {
  const auth = getAuth();
  const object = ref(getStorage(), 'proof.txt');
  if (inPage) {
    let transitions = 0;
    const stop = beforeAuthStateChanged(auth, () => { transitions++; });
    await signInAnonymously(auth);
    stop();
    await uploadBytes(object, new TextEncoder().encode('proof'));
    await updateMetadata(object, { contentType: 'text/plain', customMetadata: { verified: 'yes' } });
    const metadata = await getMetadata(object);
    return { transitions, metadata };
  }
  async function failure(action) {
    try { await action(); return { code: 'unexpected-success' }; }
    catch (error) { return { code: error.code, message: error.message, name: error.name }; }
  }
  return {
    auth: await failure(() => beforeAuthStateChanged(auth, () => {})),
    storage: await failure(() => updateMetadata(object, { contentType: 'text/plain' })),
  };
};
document.querySelector('#status').textContent = 'Ready';
`;

for (const mode of ['in-page', 'SharedWorker', 'Node'] as const) {
  test(`reported imports-only APIs retain their actual ${mode} behavior`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-availability-')));
    let server: ViteDevServer | undefined;
    const inPage = mode === 'in-page';
    const hosted = mode === 'Node';
    try {
      if (inPage) await page.addInitScript(() => { Reflect.deleteProperty(globalThis, 'SharedWorker'); });
      mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
      writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'storage.rules'), `rules_version = '2'; service firebase.storage {
        match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } }
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
      const result = await page.evaluate(value => Reflect.get(window, 'verifyAvailability')(value), inPage);
      if (inPage) {
        expect(result).toMatchObject({ transitions: 1, metadata: { contentType: 'text/plain', customMetadata: { verified: 'yes' } } });
      } else {
        expect(result.auth).toMatchObject({ code: 'auth/unsupported-in-served-mode', message: expect.stringContaining('beforeAuthStateChanged') });
        expect(result.storage).toMatchObject({ code: 'storage/unsupported-in-served-mode', message: expect.stringContaining('updateMetadata') });
      }
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
