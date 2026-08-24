import { expect, test } from '@playwright/test';

const workerOp = `
  function workerOp(worker, msg) {
    worker.port.start();
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.data.t === 'res' && event.data.id === msg.id) {
          worker.port.removeEventListener('message', handler);
          resolve(event.data);
        }
      };
      worker.port.addEventListener('message', handler);
      worker.port.postMessage(msg);
    });
  }
`;

test('CLI serves Astro Studio deep links and shares the app worker generation and data', async ({ browser }) => {
  const context = await browser.newContext();
  const app = await context.newPage();
  await app.goto('/');
  await expect(app.locator('#status')).not.toHaveText('loading');

  const marker = `shared-${Date.now()}`;
  const appGeneration = await app.evaluate(async ({ marker, helper }) => {
    // eslint-disable-next-line no-new-func
    const op = new Function(`${helper}; return workerOp;`)();
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
    });
    await op(worker, {
      t: 'op', id: 'write-shared', method: 'admin.setDocument',
      path: 'notes/astro-host', data: { marker },
    });
    return generation;
  }, { marker, helper: workerOp });

  const studio = await context.newPage();
  const response = await studio.goto('/__pyric/ui/firestore/notes/astro-host');
  expect(response?.ok()).toBeTruthy();
  await expect(studio.getByRole('navigation', { name: 'Studio' })).toBeVisible();
  await expect(studio.getByText('Starting Pyric Studio…', { exact: true })).toHaveCount(0);
  expect(await studio.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await studio.locator('link[rel="icon"]').getAttribute('href')).toBe(
    '/__pyric/ui/pyric-logo.svg',
  );
  await expect(studio.getByText(marker)).toBeVisible({ timeout: 10_000 });
  expect(await studio.evaluate(() => localStorage.getItem('pyric:worker-generation'))).toBe(appGeneration);

  expect((await context.request.get('/__pyric/ui/_astro/does-not-exist.js')).status()).toBe(404);
  await context.close();
});

test('an app-triggered worker replacement moves an open Studio page to the announced generation', async ({ browser }) => {
  const context = await browser.newContext();
  const app = await context.newPage();
  const studio = await context.newPage();
  await app.goto('/');
  await studio.goto('/__pyric/ui/firestore');
  // Navigation finishes before either client necessarily registers its
  // replacement listener. The retirement announcement is one-shot, so wait
  // for both runtimes to finish mounting before sending it.
  await expect(app.locator('#status')).not.toHaveText('loading');
  await expect(studio.getByRole('navigation', { name: 'Studio' })).toBeVisible();
  await expect(studio.getByText('Starting Pyric Studio…', { exact: true })).toHaveCount(0);

  const nextGeneration = 'fedcba9876543210';
  const appReloaded = app.waitForEvent('framenavigated', (frame) => frame === app.mainFrame());
  const studioReloaded = studio.waitForEvent('framenavigated', (frame) => frame === studio.mainFrame());
  await app.evaluate((epoch) => {
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
    });
    worker.port.start();
    worker.port.postMessage({
      t: 'op',
      id: 'replace-from-app',
      method: 'retireRuntime',
      targetEpoch: epoch,
    });
  }, nextGeneration);

  await Promise.all([appReloaded, studioReloaded]);
  expect(await app.evaluate(() => localStorage.getItem('pyric:worker-generation'))).toBe(nextGeneration);
  expect(await studio.evaluate(() => localStorage.getItem('pyric:worker-generation'))).toBe(nextGeneration);
  await context.close();
});
