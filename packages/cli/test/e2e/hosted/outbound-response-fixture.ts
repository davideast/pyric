import { expect, test, type Browser } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

export async function assertOversizedResponseRefusal(browser: Browser, operation: 'read' | 'listen'): Promise<void> {
  const fixture = await startHostedFixture();
  const requestingContext = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    const requesting = await requestingContext.newPage();
    const healthy = await healthyContext.newPage();
    let largestFrame = 0;
    let closedSockets = 0;
    const largeObservations: { size: number; hasSample: boolean }[] = [];
    let notifyClose = () => {};
    const connectionClosed = new Promise<string>(resolve => {
      notifyClose = () => resolve('connection closed before an SDK response');
    });
    requesting.on('websocket', socket => {
      const isSandboxSocket = socket.url().endsWith('/__pyric/sandbox');
      if (isSandboxSocket) {
        socket.on('framereceived', event => {
          largestFrame = Math.max(largestFrame, Buffer.byteLength(event.payload));
          const frame: unknown = JSON.parse(event.payload.toString());
          const isResultEnvelope = isBridgeMessage(frame) && frame.type === 'worker-message-result';
          if (isResultEnvelope) {
            const message = frame.message;
            const isEventBatch = message.t === 'event';
            if (isEventBatch) {
              for (const observed of message.events) {
                const isLargeSnapshot = observed.kind === 'snapshot_delivery'
                  && observed.target.kind === 'query' && observed.target.collection === 'large';
                if (isLargeSnapshot) largeObservations.push({ size: observed.size, hasSample: observed.sample !== undefined });
              }
            }
          }
        });
        socket.on('close', () => { closedSockets += 1; notifyClose(); });
      }
    });
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
    const result = await Promise.race([request, connectionClosed]);
    expect(result).toEqual({ code: 'resource-exhausted', message: 'Bridge response exceeds the 12 MiB encoded frame limit.' });
    expect(largestFrame).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(closedSockets).toBe(0);
    await healthy.locator('#write').click();
    await expect(healthy.locator('#write-result')).toHaveText('Written');
    for (const page of [requesting, healthy]) {
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    }
    await requesting.locator('#write').click();
    await expect(requesting.locator('#write-result')).toHaveText('Written');
    const usesListener = operation === 'listen';
    if (usesListener) await expect.poll(() => largeObservations).toContainEqual({ size: 7, hasSample: false });
    expect(largestFrame).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(closedSockets).toBe(0);
    expect(fixture.stderr()).not.toContain('uncaught exception');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await requestingContext.close();
    await healthyContext.close();
    await fixture.stop();
  }
}
