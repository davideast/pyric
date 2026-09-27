import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

/**
 * The Data tab's listener contract, per page shape and per transport.
 *
 * Every app reads `reads/one` once and listens to `subscriptions/one`. A
 * button writes the listened document, so each app gets a second delivery on
 * demand. The apps differ only in how the listener's data reaches the page:
 * React state, a synchronous DOM write, or pixels on a canvas with and without
 * an explicit `owner`.
 */
const studioRequire = createRequire(new URL('../../../studio/package.json', import.meta.url));

const firebase = `
import { initializeApp } from 'firebase/app';
import { collection, doc, getDocs, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
initializeApp({ projectId: 'listener-contract', apiKey: 'demo' });
export const db = getFirestore();
export { collection, doc, getDocs, onSnapshot, setDoc };
let version = 1;
export function write() { version += 1; return setDoc(doc(db, 'subscriptions/one'), { value: 'Listener v' + version }); }
`;

const apps = {
  react: `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { db, collection, getDocs, onSnapshot, write } from './firebase.js';
function App() {
  const [read, setRead] = useState('Loading read');
  const [live, setLive] = useState('Loading listener');
  useEffect(() => { getDocs(collection(db, 'reads')).then(result => setRead(result.docs[0].data().value)); }, []);
  useEffect(() => onSnapshot(collection(db, 'subscriptions'), result => setLive(result.docs[0].data().value)), []);
  return React.createElement('main', null,
    React.createElement('p', { id: 'read' }, read),
    React.createElement('p', { id: 'live' }, live),
    React.createElement('button', { id: 'write', onClick: () => write() }, 'Write'));
}
createRoot(document.getElementById('app')).render(React.createElement(App));
`,
  dom: `
import { db, collection, getDocs, onSnapshot, write } from './firebase.js';
const app = document.getElementById('app');
app.innerHTML = '<p id="read">Loading read</p><p id="live">Loading listener</p><button id="write">Write</button>';
document.getElementById('write').addEventListener('click', () => write());
getDocs(collection(db, 'reads')).then(result => { document.getElementById('read').textContent = result.docs[0].data().value; });
onSnapshot(collection(db, 'subscriptions'), result => { document.getElementById('live').textContent = result.docs[0].data().value; });
`,
  'canvas-owned': canvasApp(true),
  'canvas-unowned': canvasApp(false),
} as const;

/** A canvas game shape: the listener's data becomes pixels, never DOM. */
function canvasApp(owned: boolean): string {
  return `
import { db, collection, getDocs, onSnapshot, write } from './firebase.js';
const app = document.getElementById('app');
app.innerHTML = '<canvas id="board" width="320" height="120"></canvas><button id="write">Write</button>';
document.getElementById('write').addEventListener('click', () => write());
const canvas = document.getElementById('board');
const context = canvas.getContext('2d');
const draw = text => { context.clearRect(0, 0, 320, 120); context.fillText(text, 10, 50); globalThis.drawn = text; };
getDocs(collection(db, 'reads')).then(result => { globalThis.read = result.docs[0].data().value; });
onSnapshot(collection(db, 'subscriptions'), ${owned ? '{ owner: canvas }, ' : ''}result => draw(result.docs[0].data().value));
`;
}

type AppKind = keyof typeof apps;

async function startApp(kind: AppKind, hosted: boolean): Promise<{ url: string; close(): Promise<void> }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `pyric-listener-contract-${kind}-`)));
  mkdirSync(join(root, 'node_modules'));
  for (const name of ['react', 'react-dom']) {
    symlinkSync(dirname(studioRequire.resolve(`${name}/package.json`)), join(root, 'node_modules', name));
  }
  writeFileSync(join(root, 'index.html'), '<html><head></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(root, 'firebase.js'), firebase);
  writeFileSync(join(root, 'main.js'), apps[kind]);
  writeFileSync(join(root, 'firestore.rules'), 'service cloud.firestore { match /databases/{database}/documents { match /reads/{id} { allow read: if true; } match /subscriptions/{id} { allow read, write: if true; } } }');
  writeFileSync(join(root, 'seed.json'), JSON.stringify({ version: 1, firestore: { version: 1, savedAt: 1, firestore: {
    'reads/one': { value: 'Read ready' }, 'subscriptions/one': { value: 'Listener v1' },
  } } }));
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({ root, configFile: false, logLevel: 'silent',
      plugins: [pyric({ hosted, capture: false, ui: false, seed: 'seed.json' })],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const url = server.resolvedUrls?.local[0];
  const missingUrl = url === undefined;
  if (missingUrl) throw new Error('Vite did not expose a local URL');
  return { url, async close() { await server?.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function waitForFirstDelivery(page: Page, kind: AppKind): Promise<void> {
  const isCanvas = kind.startsWith('canvas');
  if (isCanvas) {
    await expect.poll(() => page.evaluate(() => (globalThis as { drawn?: string }).drawn)).toBe('Listener v1');
    await expect.poll(() => page.evaluate(() => (globalThis as { read?: string }).read)).toBe('Read ready');
    return;
  }
  await expect(page.locator('#read')).toHaveText('Read ready');
  await expect(page.locator('#live')).toHaveText('Listener v1');
}

async function waitForSecondDelivery(page: Page, kind: AppKind): Promise<void> {
  const isCanvas = kind.startsWith('canvas');
  if (isCanvas) await expect.poll(() => page.evaluate(() => (globalThis as { drawn?: string }).drawn)).toBe('Listener v2');
  else await expect(page.locator('#live')).toHaveText('Listener v2');
}

/** Where each app shape can put the listener on the page. */
const located: Record<AppKind, boolean> = { react: true, dom: true, 'canvas-owned': true, 'canvas-unowned': false };

const box = (page: Page) => page.locator('[data-pyric-listener-box][data-listener-target="subscriptions"]');
const row = (page: Page) => page.locator('.source-row').filter({ has: page.locator('[data-listener-row]').filter({ hasText: 'subscriptions' }) });

for (const hosted of [false, true]) {
  const transport = hosted ? 'hosted' : 'SharedWorker';
  for (const kind of Object.keys(apps) as AppKind[]) {
    test(`${transport} ${kind}: Data lists sources, Overview locates what it can, Flow and unplaced rows say why`, async ({ page }) => {
      test.setTimeout(60_000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = await startApp(kind, hosted);
      try {
        await page.goto(app.url);
        await waitForFirstDelivery(page, kind);
        await page.locator('#write').click();
        await waitForSecondDelivery(page, kind);

        await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
        await page.getByRole('tab', { name: 'Data', exact: true }).click();

        // The Data tab lists both sources with their calls and deliveries.
        const listenerRow = page.locator('[data-listener-row]').filter({ hasText: 'subscriptions' });
        const readRow = page.locator('[data-listener-row]').filter({ hasText: 'reads' });
        await expect(listenerRow).toContainText('1 call');
        await expect(listenerRow).toContainText('2 deliveries');
        await expect(readRow).toContainText('1 call');
        await expect(readRow).toContainText('1 delivery');
        // The source's history carries the write's delivery.
        await listenerRow.click();
        await expect(page.locator('[data-history-entry]').filter({ hasText: 'Update received' })).not.toHaveCount(0);
        await page.locator('[data-sources-back]').click();

        // Overview draws a box wherever the listener has a page position.
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        const eye = row(page).locator('[data-highlight-source]');
        if (located[kind]) {
          await expect(box(page).first()).toBeVisible();
          await expect(eye).toBeEnabled();
          await expect(row(page).locator('[data-listener-unplaced]')).toHaveCount(0);
        } else {
          await page.waitForTimeout(500);
          await expect(box(page)).toHaveCount(0);
          await expect(eye).toBeDisabled();
          await expect(row(page).locator('[data-listener-unplaced]')).toBeVisible();
          await expect(row(page).locator('[data-listener-unplaced]')).toContainText('owner');
        }

        // Flow follows React commits: selectable and painting on React,
        // unavailable with a visible reason everywhere else.
        const flow = page.locator('[data-listener-mode=flow]');
        const reason = page.locator('[data-flow-unavailable]');
        if (kind === 'react') {
          await expect(flow).toBeEnabled();
          await flow.click();
          await expect(flow).toHaveAttribute('aria-pressed', 'true');
          await page.locator('#write').click();
          await expect(page.locator('#live')).toHaveText('Listener v3');
          await expect(page.locator('[data-pyric-flow]').first()).toBeAttached();
        } else {
          await expect(flow).toBeDisabled();
          await expect(reason).toBeVisible();
          await expect(reason).toContainText('React');
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await app.close();
      }
    });
  }
}
