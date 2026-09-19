import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a hosted browser refuses an oversized write without reconnecting or changing shared state', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    const requesting = await context.newPage();
    const healthy = await healthyContext.newPage();
    const sentBytes: number[] = [];
    let closedSockets = 0;
    requesting.on('websocket', socket => {
      socket.on('framesent', frame => { sentBytes.push(Buffer.byteLength(frame.payload)); });
      socket.on('close', () => { closedSockets += 1; });
    });
    for (const page of [requesting, healthy]) {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
    }
    const outcome = await requesting.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      try {
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'é'.repeat(6 * 1024 * 1024) });
        return 'accepted';
      } catch (error) {
        const hasCode = typeof error === 'object' && error !== null && 'code' in error;
        return hasCode ? error.code : 'unknown';
      }
    });
    expect(outcome).toBe('resource-exhausted');
    await expect(healthy.locator('#document')).toHaveText('Empty');
    for (const page of [healthy, requesting]) {
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    }
    expect(closedSockets).toBe(0);
    expect(sentBytes.length).toBeGreaterThan(0);
    for (const bytes of sentBytes) expect(bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
  } finally {
    await context.close();
    await healthyContext.close();
    await fixture.stop();
  }
});
