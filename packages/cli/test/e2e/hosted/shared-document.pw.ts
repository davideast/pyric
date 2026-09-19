import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('normal SDK writes are observed by another browser using one Node host', async ({ browser }) => {
  const serve = await startHostedFixture();
  const writerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  try {
    const writer = await writerContext.newPage();
    const observer = await observerContext.newPage();
    await writer.goto(serve.info.url);
    await observer.goto(serve.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await expect(observer.locator('#document')).toHaveText('Empty');

    await writer.getByRole('button', { name: 'Write shared document' }).click();
    await expect(writer.locator('#write-result')).toHaveText('Written');
    await expect(writer.locator('#document')).toHaveText('Hello from the other browser');
    await expect(observer.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await writerContext.close();
    await observerContext.close();
    await serve.stop();
  }
});
