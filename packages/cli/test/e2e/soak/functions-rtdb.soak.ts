import { expect, test } from '@playwright/test';
import { chromium } from '@playwright/test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSoakServe } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIREBASE_FUNCTIONS = resolve(HERE, '../../../../conformance/node_modules/firebase-functions');

test('an unchanged onValueCreated function shares RTDB state with the app and Studio', async () => {
  const serve = await startSoakServe({
    extraFiles: {
      'firebase.json': JSON.stringify({ functions: { source: 'functions' } }),
    },
    prepare: (dir) => {
      const functionsDir = join(dir, 'functions');
      mkdirSync(join(functionsDir, 'node_modules'), { recursive: true });
      writeFileSync(
        join(functionsDir, 'package.json'),
        JSON.stringify({ name: 'functions', private: true, main: 'index.cjs' }),
      );
      writeFileSync(
        join(functionsDir, 'index.cjs'),
        `const { onValueCreated } = require('firebase-functions/v2/database');

exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent
    .child('uppercase')
    .set(event.data.val().toUpperCase()),
);
`,
      );
      symlinkSync(FIREBASE_FUNCTIONS, join(functionsDir, 'node_modules', 'firebase-functions'), 'dir');
    },
  });
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const app = await context.newPage();
    await app.goto(serve.info.url, { waitUntil: 'load' });
    await expect(app.locator('#status')).toHaveText('ready');

    const studio = await context.newPage();
    expect(serve.info.uiUrl).not.toBeNull();
    await studio.goto(serve.info.uiUrl!, { waitUntil: 'load' });
    await studio.getByRole('button', { name: 'RTDB', exact: true }).click();
    await expect(studio.getByRole('heading', { name: 'RTDB', exact: true })).toBeVisible();
    await expect
      .poll(() => serve.stderr())
      .toContain('✔ functions 1 onValueCreated trigger');

    await app.evaluate(() => window.__soak.setRtdb('messages/id/original', 'hello'));
    await expect
      .poll(() => app.evaluate(() => window.__soak.getRtdb('messages/id/uppercase')))
      .toBe('HELLO');

    await studio.locator('[data-rtdb-path-edit]').click();
    await studio.locator('[data-rtdb-path-input]').fill('/messages/id/uppercase');
    await studio.locator('[data-rtdb-path-input]').press('Enter');
    await expect(studio.locator('[data-rtdb-view-root] [data-rtdb-value]')).toHaveText('"HELLO"');

    const executionReports = serve
      .stderr()
      .split('\n')
      .filter((line) => line.includes('✔ function  makeUppercase ← /messages/id/original'));
    expect(executionReports).toEqual([
      expect.stringContaining('pushId=id'),
    ]);
  } finally {
    await browser.close().catch(() => {});
    await serve.stop();
  }
});

declare global {
  interface Window {
    __soak: {
      setRtdb(path: string, value: unknown): Promise<void>;
      getRtdb(path: string): Promise<unknown>;
    };
  }
}
