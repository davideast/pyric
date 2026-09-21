import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer, type Plugin } from 'vite';
import { pyric } from '../../dist/vite.js';

const studioRequire = createRequire(new URL('../../../studio/package.json', import.meta.url));
const dataModule = `
import { initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore, onSnapshot } from 'firebase/firestore';
initializeApp({ projectId: 'overview-test', apiKey: 'demo' });
const db = getFirestore();
export function loadData(onRead, onLive) {
  getDocs(collection(db, 'reads')).then(result => onRead(result.docs[0].data().value));
  return onSnapshot(collection(db, 'subscriptions'), result => onLive(result.docs[0].data().value));
}
`;
const app = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadData } from './data.js';
function App() {
  const [read, setRead] = useState('Loading read');
  const [live, setLive] = useState('Loading listener');
  useEffect(() => loadData(setRead, setLive), []);
  return React.createElement('main', null,
    React.createElement('p', { id: 'read' }, read),
    React.createElement('p', { id: 'live' }, live));
}
createRoot(document.getElementById('app')).render(React.createElement(App));
`;

// Delay only the chip mount through its existing mount seam. SDK setup and
// React's hook keep running; the test releases the chip after both data commits.
function holdChipMount(): Plugin {
  return {
    name: 'hold-overview-chip-mount', enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('/runtime/chip-install.js')) return;
      const mount = 'const mount = options.mount ?? mountPyricRuntimeChip;';
      if (!code.includes(mount)) throw new Error('Chip mount seam was not found');
      return code.replace(mount, `const mount = options.mount ?? (chipOptions => {
        let chip;
        globalThis.__chipMountReady = new Promise(resolve => {
          globalThis.__releaseChipMount = () => { chip = mountPyricRuntimeChip(chipOptions); resolve(); };
        });
        return { element: options.document.createElement('div'), dispose() { chip?.dispose(); } };
      });`);
    },
  };
}

for (const hosted of [false, true]) {
  test(`Overview highlights initial module reads before any interaction, including after reload (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-overview-')));
    let server: ViteDevServer | undefined;
    try {
      mkdirSync(join(root, 'node_modules'));
      for (const name of ['react', 'react-dom']) {
        symlinkSync(dirname(studioRequire.resolve(`${name}/package.json`)), join(root, 'node_modules', name));
      }
      writeFileSync(join(root, 'index.html'), '<html><head></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'data.js'), dataModule);
      writeFileSync(join(root, 'firestore.rules'), 'service cloud.firestore { match /databases/{database}/documents { match /reads/{id} { allow read: if true; } match /subscriptions/{id} { allow read: if true; } } }');
      writeFileSync(join(root, 'seed.json'), JSON.stringify({ version: 1, firestore: { version: 1, savedAt: 1, firestore: {
        'reads/one': { value: 'Read ready' }, 'subscriptions/one': { value: 'Listener ready' },
      } } }));
      server = await createServer({ root, configFile: false, logLevel: 'silent',
        plugins: [pyric({ hosted, capture: false, ui: false, seed: 'seed.json' }), holdChipMount()],
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      await page.goto(server.resolvedUrls!.local[0]!);
      for (let visit = 0; visit < 2; visit++) {
        if (visit > 0) await page.reload();
        await expect(page.locator('#read')).toHaveText('Read ready');
        await expect(page.locator('#live')).toHaveText('Listener ready');
        // Both initial commits must precede the chip and createListenerMode.
        await expect(page.locator('pyric-runtime-chip, [data-pyric-runtime-chip-host]')).toHaveCount(0);
        await page.evaluate(async () => {
          const gate = globalThis as typeof globalThis & { __releaseChipMount: () => void; __chipMountReady: Promise<void> };
          gate.__releaseChipMount();
          await gate.__chipMountReady;
        });
        // No application click, write, or render follows enable.
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
        await page.getByRole('tab', { name: 'Data', exact: true }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(page.locator('[data-pyric-listener-box][data-listener-target="reads"]').first()).toBeVisible();
        await expect(page.locator('[data-pyric-listener-box][data-listener-target="subscriptions"]').first()).toBeVisible();
      }
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
