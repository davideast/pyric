import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('failed hosted initialization reports the failure without starting a local sandbox', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    await context.route('**/__pyric/init.json', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
    const page = await context.newPage();
    const errors: string[] = [];
    const workerScripts: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      const isWorkerScript = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
      if (isWorkerScript) workerScripts.push(request.url());
    });
    await page.goto(serve.info.url);

    await expect.poll(() => errors).toContain('Hosted sandbox initialization failed: /__pyric/init.json → 503');
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
    expect(workerScripts).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
});

test('a hosted page rejects initialization that selects a local sandbox', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    await context.route('**/__pyric/init.json', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({ response, json: { ...payload, hosted: false } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const workerScripts: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      const isWorkerScript = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
      if (isWorkerScript) workerScripts.push(request.url());
    });
    await page.goto(serve.info.url);

    await expect.poll(() => errors).toContain(
      'Hosted sandbox initialization failed: /__pyric/init.json does not select the requested Node host.',
    );
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
    expect(workerScripts).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
});
