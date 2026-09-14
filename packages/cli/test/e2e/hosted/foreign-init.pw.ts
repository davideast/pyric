import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a hosted page rejects an entire initialization response from another project', async ({ browser, request }) => {
  const expectedHost = await startHostedFixture();
  try {
    const otherHost = await startHostedFixture();
    try {
      const otherContext = await browser.newContext();
      const appContext = await browser.newContext();
      try {
        const otherApp = await otherContext.newPage();
        await otherApp.goto(otherHost.info.url);
        await expect(otherApp.locator('#document')).toHaveText('Empty');
        await otherApp.getByRole('button', { name: 'Write shared document' }).click();
        await expect(otherApp.locator('#write-result')).toHaveText('Written');
        const otherInit = await request.get(`${otherHost.info.url}/__pyric/init.json`);

        await appContext.route('**/__pyric/init.json', (route) => route.fulfill({ response: otherInit }));
        const app = await appContext.newPage();
        const errors: string[] = [];
        const workerScripts: string[] = [];
        app.on('pageerror', (error) => errors.push(error.message));
        appContext.on('request', (request) => {
          const isWorkerScript = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
          if (isWorkerScript) workerScripts.push(request.url());
        });
        await app.goto(expectedHost.info.url);

        try {
          await expect.poll(() => errors).toContain(
            'Hosted sandbox initialization failed: /__pyric/init.json belongs to a different project.',
          );
        } catch (error) {
          console.error('Misdirected app document:', await app.locator('#document').textContent());
          throw error;
        }
        await expect(app.locator('#document')).toHaveText('Starting');
        await expect(app.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
        expect(workerScripts).toEqual([]);
        await expect(otherApp.locator('#document')).toHaveText('Hello from the other browser');
      } finally {
        await appContext.close();
        await otherContext.close();
      }
    } finally {
      await otherHost.stop();
    }
  } finally {
    await expectedHost.stop();
  }
});
