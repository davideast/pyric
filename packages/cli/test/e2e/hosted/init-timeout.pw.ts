import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('hosted initialization has a five-second deadline without creating a fallback store', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const requestedInit = Promise.withResolvers<void>();
    await context.route('**/__pyric/init.json', () => requestedInit.resolve());
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    const errors: string[] = [];
    const workerScripts: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      const isWorkerScript = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
      if (isWorkerScript) workerScripts.push(request.url());
    });
    await page.goto(serve.info.url, { waitUntil: 'commit' });
    await requestedInit.promise;
    await page.clock.runFor(4_999);
    expect(errors).toEqual([]);
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();

    await page.clock.runFor(1);
    await expect.poll(() => errors).toContain(
      'Hosted sandbox initialization failed: /__pyric/init.json did not complete within 5000 ms.',
    );
    expect(workerScripts).toEqual([]);
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
  } finally {
    await context.close();
    await serve.stop();
  }
});
