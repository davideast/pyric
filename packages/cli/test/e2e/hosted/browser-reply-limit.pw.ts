import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

const frameLimit = 12 * 1024 * 1024;
for (const frameBytes of [frameLimit - 1, frameLimit, frameLimit + 1]) {
  test(`browser input enforces the ${frameBytes}-byte UTF-8 boundary without interrupting another browser`, async ({ browser }) => {
    const fixture = await startHostedFixture();
    const context = await browser.newContext();
    const healthyContext = await browser.newContext();
    let injectOversize = false;
    const refused = Promise.withResolvers<number>();
    const closeCodes: Array<number | undefined> = [];
    let sentBytes = 0;
    await context.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      let readId: string | undefined;
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isWorkerRequest = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerRequest) {
          const message = frame.message;
          const isTargetRead = injectOversize && message.t === 'op' && message.method === 'getDoc';
          if (isTargetRead) readId = message.id;
        }
        server.send(data);
      });
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isWorkerReply = isBridgeMessage(frame) && frame.type === 'worker-message-result';
        if (isWorkerReply) {
          const message = frame.message;
          const isTargetReply = readId !== undefined && message.t === 'res' && message.id === readId;
          if (isTargetReply) {
            const padded = { ...frame, padding: '' };
            const paddingBytes = frameBytes - Buffer.byteLength(JSON.stringify(padded));
            padded.padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
            const payload = JSON.stringify(padded);
            sentBytes = Buffer.byteLength(payload);
            route.send(payload);
            return;
          }
        }
        route.send(data);
      });
      route.onClose(async (code) => {
        await server.close();
        closeCodes.push(code);
        refused.resolve(code);
      });
    });
    try {
      const requesting = await context.newPage();
      const healthy = await healthyContext.newPage();
      for (const page of [requesting, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
      }
      injectOversize = true;
      const result = await requesting.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        try {
          await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'));
          return 'accepted';
        } catch (error) {
          const hasCode = typeof error === 'object' && error !== null && 'code' in error;
          return hasCode ? error.code : 'unknown';
        }
      });
      expect(sentBytes).toBe(frameBytes);
      const exceedsLimit = frameBytes > frameLimit;
      if (exceedsLimit) {
        expect(result).toBe('unavailable');
        expect(await refused.promise).toBe(4009);
      } else {
        expect(result).toBe('accepted');
        expect(closeCodes).toEqual([]);
        await requesting.locator('#write').click();
        await expect(requesting.locator('#write-result')).toHaveText('Written');
      }
      await healthy.locator('#write').click();
      await expect(healthy.locator('#write-result')).toHaveText('Written');
      await expect(healthy.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await Promise.all([context.close(), healthyContext.close()]).finally(() => fixture.stop());
    }
  });
}
