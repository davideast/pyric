import { expect, test, type Browser } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { observeHostedFrames } from './frame-observation-fixture.js';

export async function assertOversizedResponseRefusal(browser: Browser, operation: 'read' | 'listen'): Promise<void> {
  const fixture = await startHostedFixture();
  const requestingContext = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    const requesting = await requestingContext.newPage();
    const healthy = await healthyContext.newPage();
    await observeHostedFrames(requesting);
    for (const page of [requesting, healthy]) {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
    }
    const request = requesting.evaluate(async operation => {
      const sdk = await import('firebase/firestore');
      const db = sdk.getFirestore();
      const usesListener = operation === 'listen';
      let payload = 'x'.repeat(2 * 1024 * 1024);
      if (usesListener) payload = 'é'.repeat(1024 * 1024);
      for (const id of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
        await sdk.setDoc(sdk.doc(db, 'large', id), { payload });
      }
      let unsubscribe = () => {};
      try {
        if (usesListener) {
          const count = await new Promise<number>((resolve, reject) => {
            unsubscribe = sdk.onSnapshot(sdk.collection(db, 'large'), snapshot => resolve(snapshot.size), reject);
          });
          return { count };
        }
        const snapshot = await sdk.getDocs(sdk.collection(db, 'large'));
        return { count: snapshot.size };
      } catch (error) {
        const isError = error instanceof Error;
        const hasCode = typeof error === 'object' && error !== null && 'code' in error;
        return {
          code: hasCode ? error.code : null,
          message: isError ? error.message : 'Non-Error rejection',
        };
      } finally {
        unsubscribe();
      }
    }, operation).catch(error => {
      const isError = error instanceof Error;
      return { evaluationError: isError ? error.message : 'Page evaluation failed' };
    });
    const result = await request;
    expect(result).toEqual({ code: 'resource-exhausted', message: 'Bridge response exceeds the 12 MiB encoded frame limit.' });
    expect(await requesting.evaluate(() => globalThis.__pyricFrameObservations.largestFrame)).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(await requesting.evaluate(() => globalThis.__pyricFrameObservations.closedSockets)).toBe(0);
    await healthy.locator('#write').click();
    await expect(healthy.locator('#write-result')).toHaveText('Written');
    for (const page of [requesting, healthy]) {
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    }
    await requesting.locator('#write').click();
    await expect(requesting.locator('#write-result')).toHaveText('Written');
    const usesListener = operation === 'listen';
    if (usesListener) {
      await requesting.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/frame-barrier'), { message: 'Observation check complete' });
      });
      // Observe a later write on the same stream before asserting that the summary was retained.
      await requesting.waitForFunction(() => globalThis.__pyricFrameObservations.barrier);
      const observations = await requesting.evaluate(() => globalThis.__pyricFrameObservations.largeObservations);
      expect(observations).toContainEqual({ size: 7, hasSample: false });
    }
    expect(await requesting.evaluate(() => globalThis.__pyricFrameObservations.largestFrame)).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(await requesting.evaluate(() => globalThis.__pyricFrameObservations.closedSockets)).toBe(0);
    expect(fixture.stderr()).not.toContain('uncaught exception');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await requestingContext.close();
    await healthyContext.close();
    await fixture.stop();
  }
}
