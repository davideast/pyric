import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

// An in-page app (no SharedWorker) that imports only firebase/firestore is held
// to the project's firestore.rules from its first write.
const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const app = `
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
initializeApp({ projectId: 'in-page-rules' });
async function write(value) {
  try { await setDoc(doc(getFirestore(), 'open/a'), { v: value }); return 'ok'; }
  catch (error) { return error.code; }
}
window.writeBoth = async () => ({ allowed: await write(1), denied: await write(2) });
document.querySelector('#status').textContent = 'Ready';
`;
const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} { allow read, write: if request.resource.data.v == 1; }
  }
}`;

test('an in-page firebase/firestore app enforces firestore.rules', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-in-page-rules-')));
  let server: ViteDevServer | undefined;
  try {
    await page.addInitScript(() => { Reflect.deleteProperty(globalThis, 'SharedWorker'); });
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), app);
    writeFileSync(join(root, 'firestore.rules'), rules);
    server = await createServer({ root, configFile: false, logLevel: 'silent',
      plugins: [pyric({ hosted: false, capture: false, ui: false })],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    const missingUrl = url === undefined;
    if (missingUrl) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Ready');
    const result = await page.evaluate(() => Reflect.get(window, 'writeBoth')());
    expect(result).toEqual({ allowed: 'ok', denied: 'permission-denied' });
  } finally {
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
