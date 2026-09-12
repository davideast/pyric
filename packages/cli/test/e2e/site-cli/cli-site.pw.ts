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

test('a served page attributes a listener to the owner the page passed', async ({ browser }) => {
  const context = await browser.newContext();
  const app = await context.newPage();
  await app.goto('/');
  await expect(app.locator('#status')).not.toHaveText('loading');

  // The listener is opened from the page with an owner the page named. The
  // sandbox that records the attach runs in the SharedWorker.
  await app.locator('#listen').click();
  await expect.poll(() => app.evaluate(() => (
    window as unknown as { __noteFires: number }
  ).__noteFires)).toBeGreaterThan(0);

  const chipHost = app.locator('[data-pyric-runtime-chip-host]');
  await expect(chipHost).toBeAttached();
  const expand = chipHost.locator('[data-expand]');
  if (await expand.isVisible()) await expand.click();
  await chipHost.locator('[data-toggle-listeners]').click();

  // Nothing on the page can be outlined for a name-only owner, so the listener
  // lands in the chip's own list. Its label is the name the page passed, not a
  // function out of the worker bundle.
  const rows = chipHost.locator('[data-listener-panel] .listener-row');
  await expect(rows.filter({ hasText: 'notes-panel' })).toHaveCount(1, { timeout: 10_000 });
  await expect(rows.filter({ hasText: 'notes/astro-host' })).toHaveCount(1);
  await context.close();
});

test('the Listeners tab renders from the routed query and from the chip deep link', async ({ browser }) => {
  const context = await browser.newContext();
  const studio = await context.newPage();
  const consoleErrors: string[] = [];
  studio.on('console', (message) => {
    // The fixture app mounts no `/__pyric/state` endpoint, so Studio's probe
    // for it logs a resource 404 on every page. Ignore load failures and keep
    // the assertion on script errors, which is what a render loop reports.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      consoleErrors.push(message.text());
    }
  });
  studio.on('pageerror', (error) => consoleErrors.push(error.message));

  // The tab is a Traffic journal panel: its eyebrow names the view, and the
  // headline states a finding that moves with the data, so the panel itself is
  // what a render assertion can hold on to.
  await studio.goto('/__pyric/ui/traffic/?view=listeners');
  await expect(studio.locator('[data-pyric-ui="traffic-listeners-view"]')).toBeVisible();
  expect(consoleErrors).toEqual([]);

  // The chip's deep-link shape: the Listeners tab selects a row off the URL.
  await studio.goto('/__pyric/ui/traffic/?view=listeners&listener=l-1&target=notes');
  await expect(studio.locator('[data-pyric-ui="traffic-listeners-view"]')).toBeVisible();
  expect(consoleErrors).toEqual([]);

  // The hub path carries the same query: Studio replays it onto Traffic.
  await studio.goto('/__pyric/ui/studio?view=listeners&listener=l-1&target=notes');
  await expect(studio.locator('[data-pyric-ui="traffic-listeners-view"]')).toBeVisible();
  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('the runtime chip link reaches the Listeners tab without losing its query', async ({ browser }) => {
  const context = await browser.newContext();

  // The served host answers the extension-less Studio path with a redirect to
  // the trailing-slash form. The query has to survive it.
  const redirect = await context.request.get('/__pyric/ui/studio?view=listeners', {
    maxRedirects: 0,
  });
  if (redirect.status() === 301) {
    expect(redirect.headers()['location']).toBe('/__pyric/ui/studio/?view=listeners');
  }

  const app = await context.newPage();
  await app.goto('/');
  await expect(app.locator('#status')).not.toHaveText('loading');
  await app.locator('#listen').click();

  const chipHost = app.locator('[data-pyric-runtime-chip-host]');
  await expect(chipHost).toBeAttached();
  const expand = chipHost.locator('[data-expand]');
  if (await expand.isVisible()) await expand.click();
  await chipHost.locator('[data-toggle-listeners]').click();

  const link = chipHost.locator('[data-open-listeners-studio]');
  await expect(link).toBeAttached();
  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();

  const studio = await context.newPage();
  const consoleErrors: string[] = [];
  studio.on('console', (message) => {
    // The fixture app mounts no `/__pyric/state` endpoint, so Studio's probe
    // for it logs a resource 404 on every page. Ignore load failures and keep
    // the assertion on script errors, which is what a render loop reports.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      consoleErrors.push(message.text());
    }
  });
  studio.on('pageerror', (error) => consoleErrors.push(error.message));
  await studio.goto(href as string);
  await expect(studio.locator('[data-pyric-ui="traffic-listeners-view"]')).toBeVisible();
  expect(new URL(studio.url()).searchParams.get('view')).toBe('listeners');
  expect(consoleErrors).toEqual([]);
  await context.close();
});
