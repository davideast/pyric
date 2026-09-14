import { expect, test, type Browser } from '@playwright/test';
import { isBridgeMessage, type WorkerMessageFrame } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

/** Corrupt one real SDK write on the wire, then verify refusal, isolation and recovery. */
export async function assertMalformedWriteRecovery(
  browser: Browser,
  corruptFrame: (frame: WorkerMessageFrame) => string,
): Promise<void> {
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
              server.send(corruptFrame(frame));
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
}
