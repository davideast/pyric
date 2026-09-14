import { test, expect, type Route } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a delayed browser waits for initialization and reads the existing hosted document', async ({ browser }) => {
  const serve = await startHostedFixture();
  const writerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  try {
    const writer = await writerContext.newPage();
    await writer.goto(serve.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');

    const heldInit = Promise.withResolvers<Route>();
    await observerContext.route('**/__pyric/init.json', (route) => heldInit.resolve(route));
    const observer = await observerContext.newPage();
    await observer.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await observer.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    const errors: string[] = [];
    const workerScripts: string[] = [];
    observer.on('pageerror', (error) => errors.push(error.message));
    observerContext.on('request', (request) => {
      const isWorkerScript = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
      if (isWorkerScript) workerScripts.push(request.url());
    });
    await observer.goto(serve.info.url, { waitUntil: 'commit' });
    const initRoute = await heldInit.promise;
    await observer.clock.runFor(4_000);
    await expect(observer.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
    await writer.getByRole('button', { name: 'Write shared document' }).click();
    await expect(writer.locator('#write-result')).toHaveText('Written');

    await initRoute.continue();
    await expect(observer.locator('#document')).toHaveText('Hello from the other browser');
    await observer.clock.runFor(6_000);
    await expect(observer.getByRole('button', { name: 'Write shared document' })).toBeEnabled();
    expect(errors).toEqual([]);
    expect(workerScripts).toEqual([]);
  } finally {
    await writerContext.close();
    await observerContext.close();
    await serve.stop();
  }
});
