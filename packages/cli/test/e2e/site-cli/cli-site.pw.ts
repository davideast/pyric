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
  await expect(studio.getByText(marker)).toBeVisible({ timeout: 10_000 });
  expect(await studio.evaluate(() => localStorage.getItem('pyric:worker-generation'))).toBe(appGeneration);

  expect((await context.request.get('/__pyric/ui/docs/does-not-exist')).status()).toBe(404);
  expect((await context.request.get('/__pyric/ui/_astro/does-not-exist.js')).status()).toBe(404);
  await context.close();
});

test('CLI documentation pages do not start a SharedWorker', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const response = await page.goto('/__pyric/ui/docs/overview/');
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Firebase that runs in your browser' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests.filter((url) => url.includes('/__pyric/sdk/worker.js'))).toEqual([]);
});
