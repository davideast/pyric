import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

test('an oversized listener refused during creation is not retained for reconnect', async ({ page }) => {
  const fixture = await startHostedFixture();
  let interrupted = false;
  let interrupt: (() => Promise<void>) | undefined;
  const restored = Promise.withResolvers<void>();
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    route.onMessage(data => {
      const frame: unknown = JSON.parse(data.toString());
      const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
      if (isWorkerFrame) {
        const message = frame.message;
        const isDocumentListener = message.t === 'sub' && typeof message.target === 'object' && '__ref' in message.target && message.target.__ref === 'doc';
        if (isDocumentListener) {
          if (interrupted) restored.resolve();
          else {
            interrupt = async () => {
              interrupted = true;
              await route.close({ code: 1001, reason: 'Verify refused listener cleanup' });
              await server.close();
            };
          }
        }
      }
      server.send(data);
    });
    server.onMessage(data => route.send(data));
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const refusal = await page.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      const target = sdk.query(sdk.collection(sdk.getFirestore(), 'shared'), sdk.where('message', '==', 'é'.repeat(6 * 1024 * 1024)));
      try {
        const stop = sdk.onSnapshot(target, () => {});
        stop();
        return 'accepted';
      } catch (error) {
        const hasCode = typeof error === 'object' && error !== null && 'code' in error;
        return hasCode ? error.code : 'unknown';
      }
    });
    expect(refusal).toBe('resource-exhausted');
    const cut = interrupt;
    const hasNoSocket = cut === undefined;
    if (hasNoSocket) throw new Error('The app did not establish its document listener');
    await cut();
    await restored.promise;
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await page.close();
    await fixture.stop();
  }
});
