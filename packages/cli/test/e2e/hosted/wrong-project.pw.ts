import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a stale bridge address cannot attach the app to another hosted project', async ({ browser, request }) => {
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
        const otherInitResponse = await request.get(`${otherHost.info.url}/__pyric/init.json`);
        const otherInit: { bridgeUrl: string } = await otherInitResponse.json();

        await appContext.route('**/__pyric/init.json', async (route) => {
          const response = await route.fetch();
          const payload = await response.json();
          await route.fulfill({ response, json: { ...payload, bridgeUrl: otherInit.bridgeUrl } });
        });
        const app = await appContext.newPage();
        const errors: string[] = [];
        app.on('pageerror', (error) => errors.push(error.message));
        await app.goto(expectedHost.info.url);

        try {
          await expect.poll(() => errors).toContain('The selected hosted sandbox belongs to a different project.');
        } catch (error) {
          console.error('Misdirected app document:', await app.locator('#document').textContent());
          throw error;
        }
        await expect(app.locator('#document')).toHaveText('Starting');
        await expect(app.getByRole('button', { name: 'Write shared document' })).toBeDisabled();
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
