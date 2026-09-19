import { test, expect, type Route } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('hosted initialization has a five-second deadline without creating a fallback store', async ({ browser }) => {
  test.setTimeout(20_000);
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    let heldInit: Route | undefined;
    await context.route('**/__pyric/init.json', route => { heldInit = route; });
    await context.addInitScript(() => {
      const nativeFetch = window.fetch;
      window.fetch = Object.assign(function (input: RequestInfo | URL, options?: RequestInit) {
        const observesInit = input === '/__pyric/init.json';
        if (observesInit) options?.signal?.addEventListener('abort', () => {
          document.documentElement.dataset.initFetch = 'aborted';
        }, { once: true });
        return nativeFetch(input, options);
      }, { preconnect: nativeFetch.preconnect });
    });
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
    await expect.poll(() => heldInit !== undefined, { timeout: 5_000, message: 'Hosted initialization must issue its native fetch.' }).toBe(true);
    await page.clock.runFor(4_999);
    expect(errors).toEqual([]);
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();

    await page.clock.runFor(1);
    await expect.poll(() => errors).toContain(
      'Hosted sandbox initialization failed: /__pyric/init.json did not complete within 5000 ms.',
    );
    await expect(page.locator('html')).toHaveAttribute('data-init-fetch', 'aborted');
    await heldInit?.continue();
    await page.clock.runFor(10_000);
    expect(workerScripts).toEqual([]);
    await expect(page.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
  } finally {
    await context.close();
    await serve.stop();
  }
});
