import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createPyricNamespace } from '../../src/serve/namespace.js';

test('missing Studio assets show an actionable error instead of the host app', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'studio-navigation-'));
  writeFileSync(join(root, 'index.html'), '<html><body><h1>Host application</h1><a href="/__pyric/ui/">Studio</a></body></html>');
  const namespace = createPyricNamespace({ sdkDir: root, initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }), studio: {} });
  const server = await createServer({
    root, configFile: false, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'studio-navigation-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        Promise.resolve(namespace(req, res, new URL(req.url!, 'http://localhost')))
          .then(handled => { if (!handled) next(); }).catch(next);
      });
    } }],
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('No server port');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const navigation = page.waitForResponse(response => response.url().endsWith('/__pyric/ui/') && response.request().isNavigationRequest());
    await page.getByRole('link', { name: 'Studio', exact: true }).click();
    expect((await navigation).status()).toBe(503);
    await expect(page.getByRole('heading', { name: 'Studio is unavailable' })).toBeVisible();
    await expect(page.getByText('Host application')).toHaveCount(0);
    await expect(page.getByText(/full build/)).toBeVisible();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the served Studio entry loads its navigation instead of the host app', async ({ page, baseURL }) => {
  const response = await page.goto(`${baseURL}/__pyric/ui/studio/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Firestore', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Auth', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Studio is unavailable' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Firestore', exact: true }).first().click();
  await expect(page).toHaveURL(/\/__pyric\/ui\/firestore\/?$/);
  await page.getByRole('link', { name: 'Auth', exact: true }).first().click();
  await expect(page).toHaveURL(/\/__pyric\/ui\/auth\/?$/);
});
