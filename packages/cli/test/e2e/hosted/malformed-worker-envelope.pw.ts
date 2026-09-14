import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

const malformedMessages = [
  { name: 'null', value: null },
  { name: 'array', value: [] },
  { name: 'number', value: 7 },
  { name: 'boolean', value: false },
  { name: 'missing message', value: undefined },
  { name: 'missing type', value: {} },
  { name: 'string', value: 'invalid' },
  { name: 'unknown message type', value: { t: 'unsupported' } },
];

for (const scenario of malformedMessages) {
  test(`worker envelope with ${scenario.name} cannot leave a request pending or interrupt another app`, async ({ browser }) => {
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
              const corruptsWrite = !injected && message.t === 'op' && message.method === 'setDoc';
              if (corruptsWrite) {
                injected = true;
                server.send(JSON.stringify({ ...frame, message: scenario.value }));
                return;
              }
            }
          }
          server.send(data);
        });
        server.onMessage(data => route.send(data));
      });
      const broken = await brokenContext.newPage();
      const healthy = await healthyContext.newPage();
      for (const page of [broken, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
      }
      await broken.getByRole('button', { name: 'Write shared document' }).click();
      await expect(broken.locator('#write-result')).toContainText('Write failed:');
      expect(injected).toBe(true);
      await expect(healthy.locator('#document')).toHaveText('Empty');
      await healthy.getByRole('button', { name: 'Write shared document' }).click();
      await expect(healthy.locator('#write-result'), fixture.stderr()).toHaveText('Written');
      await expect(healthy.locator('#document')).toHaveText('Hello from the other browser');
      await expect(broken.locator('#document')).toHaveText('Hello from the other browser');
      await broken.getByRole('button', { name: 'Write shared document' }).click();
      await expect(broken.locator('#write-result')).toHaveText('Written');
      expect(fixture.stderr()).not.toContain('uncaught exception');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await brokenContext.close();
      await healthyContext.close();
      await fixture.stop();
    }
  });
}
