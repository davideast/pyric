import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

const studioRequire = createRequire(new URL('../../../../studio/package.json', import.meta.url));
const app = `import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
import { title } from './title.js';
initializeApp({ projectId: 'highlight-test', apiKey: 'demo' });
const counter = doc(getFirestore(), 'counters/main');
let next = 0;
function App({ title }) {
  const [value, setValue] = useState(0);
  useEffect(() => onSnapshot(counter, snapshot => setValue(snapshot.data()?.value ?? 0)), []);
  return React.createElement('section', null,
    React.createElement('h1', null, title),
    React.createElement('output', { id: 'value' }, value),
    React.createElement('button', { onClick: () => setDoc(counter, { value: ++next }) }, 'Increment'));
}
const root = createRoot(document.getElementById('app'));
root.render(React.createElement(App, { title }));
if (import.meta.hot) import.meta.hot.accept('./title.js', next => root.render(React.createElement(App, { title: next.title })));
`;

for (const { hosted, devTools } of [
  { hosted: true, devTools: false },
  { hosted: false, devTools: false },
  { hosted: true, devTools: true },
  { hosted: false, devTools: true },
]) {
  test(`React highlights survive delayed startup and HMR (${hosted ? 'Node' : 'SharedWorker'}, DevTools ${devTools})`, async ({
    page,
  }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-highlights-')));
    let server: ViteDevServer | undefined;
    try {
      mkdirSync(join(root, 'node_modules'));
      for (const name of ['react', 'react-dom']) {
        symlinkSync(
          dirname(studioRequire.resolve(`${name}/package.json`)),
          join(root, 'node_modules', name),
        );
      }
      writeFileSync(
        join(root, 'index.html'),
        '<html><head></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
      );
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'title.js'), 'export const title = "Before HMR";');
      writeFileSync(
        join(root, 'firestore.rules'),
        'service cloud.firestore { match /databases/{database}/documents { match /counters/{id} { allow read, write: if true; } } }',
      );
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [pyric({ hosted, capture: false, ui: false })],
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      const url = server.resolvedUrls!.local[0]!;
      await page.route('**/__pyric/init.json', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await route.continue();
      });
      if (devTools) {
        await page.addInitScript(() => {
          const renderers = new Map();
          const extension = {
            commits: 0,
            hook: {
              supportsFiber: true,
              renderers,
              inject(renderer: unknown) {
                const id = renderers.size + 1;
                renderers.set(id, renderer);
                return id;
              },
              onCommitFiberRoot() {
                extension.commits++;
              },
              onCommitFiberUnmount() {},
              onPostCommitFiberRoot() {},
              checkDCE() {},
            },
          };
          Object.assign(globalThis, {
            __testDevTools: extension,
            __REACT_DEVTOOLS_GLOBAL_HOOK__: extension.hook,
          });
        });
      }
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Before HMR' })).toBeVisible();
      await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
      await page.getByRole('tab', { name: 'Data', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Flow', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await page.getByRole('button', { name: 'Increment', exact: true }).click();
      await expect(page.locator('#value')).toHaveText('1');
      await expect(page.locator('[data-pyric-listener-box]').first()).toBeVisible();
      await page.getByRole('button', { name: 'Flow', exact: true }).click();
      await page.getByRole('button', { name: 'Increment', exact: true }).click();
      await expect(page.locator('[data-pyric-flow]').first()).toBeVisible();
      writeFileSync(join(root, 'title.js'), 'export const title = "After HMR";');
      await expect(page.getByRole('heading', { name: 'After HMR' })).toBeVisible();
      await page.getByRole('button', { name: 'Increment', exact: true }).click();
      await expect(page.locator('#value')).toHaveText('3');
      await expect(page.locator('[data-pyric-flow]').first()).toBeVisible();
      if (devTools) {
        const extension = await page.evaluate(() => {
          const view = globalThis as typeof globalThis & {
            __testDevTools: { commits: number; hook: unknown };
            __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
          };
          return {
            commits: view.__testDevTools.commits,
            preserved: view.__testDevTools.hook === view.__REACT_DEVTOOLS_GLOBAL_HOOK__,
          };
        });
        expect(extension.preserved).toBe(true);
        expect(extension.commits).toBeGreaterThan(0);
      }
      await page.reload();
      await expect(page.getByRole('heading', { name: 'After HMR' })).toBeVisible();
      await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
      await page.getByRole('tab', { name: 'Data', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Flow', exact: true })).toBeEnabled();
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
