import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

const invalidIds = [
  { name: 'null', value: null },
  { name: 'missing', value: undefined },
];

for (const scenario of invalidIds) {
  test(`a ${scenario.name} subscription ID cannot strand the original listener or interrupt another app`, async ({ browser }) => {
    test.setTimeout(30_000);
    const fixture = await startHostedFixture();
    const brokenContext = await browser.newContext();
    const healthyContext = await browser.newContext();
    try {
      let injected = false;
      await brokenContext.routeWebSocket('**/__pyric/sandbox', route => {
        const server = route.connectToServer();
        route.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const isRecognizedFrame = isBridgeMessage(frame);
          if (isRecognizedFrame) {
            const isWorkerMessage = frame.type === 'worker-message';
            if (isWorkerMessage) {
              const message = frame.message;
              const isSubscription = message.t === 'sub';
              if (isSubscription) {
                const target = message.target;
                const isDocument = typeof target === 'object' && '__ref' in target && target.__ref === 'doc';
                const corruptsSubscription = !injected && isDocument;
                if (corruptsSubscription) {
                  injected = true;
                  server.send(JSON.stringify({ ...frame, message: { ...message, subId: scenario.value } }));
                  return;
                }
              }
            }
          }
          server.send(data);
        });
        server.onMessage(data => route.send(data));
      });
      const healthy = await healthyContext.newPage();
      await healthy.goto(fixture.info.url);
      await expect(healthy.locator('#document')).toHaveText('Empty');
      const broken = await brokenContext.newPage();
      await broken.goto(fixture.info.url);
      await expect(broken.locator('#document')).toHaveText('Empty');
      expect(injected).toBe(true);
      await healthy.getByRole('button', { name: 'Write shared document' }).click();
      await expect(healthy.locator('#write-result')).toHaveText('Written');
      for (const page of [healthy, broken]) {
        await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      }
      expect(fixture.stderr()).not.toContain('uncaught exception');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await brokenContext.close();
      await healthyContext.close();
      await fixture.stop();
    }
  });
}
