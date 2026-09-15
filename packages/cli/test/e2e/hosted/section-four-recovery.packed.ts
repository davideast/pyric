import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { packedProject, startPackedServer } from './section-four-fixture.js';

test('checkpoint disables writes while reconnecting and never retries a lost acknowledgment', async ({ page, context }) => {
  const project = packedProject();
  const host = startPackedServer(project, 'hosted');
  const allowRecovery = Promise.withResolvers<void>();
  let writeId: string | undefined;
  let writes = 0;
  let droppedReply = false;
  await context.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    route.onMessage(async data => {
      const frame: unknown = JSON.parse(data.toString());
      const isFrame = isBridgeMessage(frame);
      const isRecovery = isFrame && frame.type === 'attach' && droppedReply;
      if (isRecovery) await allowRecovery.promise;
      const isWorkerRequest = isFrame && frame.type === 'worker-message';
      if (isWorkerRequest) {
        const request = frame.message;
        const isWrite = request.t === 'op' && request.method === 'setDoc';
        if (isWrite) {
          writeId = request.id;
          writes += 1;
        }
      }
      server.send(data);
    });
    server.onMessage(data => {
      const frame: unknown = JSON.parse(data.toString());
      const isReply = isBridgeMessage(frame) && frame.type === 'worker-message-result';
      const isWriteReply = isReply && frame.message.t === 'res' && frame.message.id === writeId;
      const dropsReply = isWriteReply && !droppedReply;
      if (dropsReply) {
        droppedReply = true;
        void route.close({ code: 1001, reason: 'Lost write acknowledgment' });
        void server.close();
        return;
      }
      route.send(data);
    });
  });
  try {
    await page.goto(await host.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.locator('#write').click();
    await expect(page.locator('#result')).toContainText('Requests already sent may have completed');
    await expect(page.locator('#connection')).toHaveText('Reconnecting');
    await expect(page.locator('#write')).toBeDisabled();
    expect(writes).toBe(1);
    allowRecovery.resolve();
    await expect(page.locator('#connection')).toHaveText('Connected');
    await expect(page.locator('#write')).toBeEnabled();
    await expect(page.locator('#document')).toContainText('Write ');
    await expect(page.locator('#result')).toContainText('Requests already sent may have completed');
    expect(writes).toBe(1);
    const original = await page.locator('#document').innerText();
    await page.locator('#write').click();
    await expect(page.locator('#result')).toHaveText('Written');
    await expect(page.locator('#document')).not.toHaveText(original);
    expect(writes).toBe(2);
  } finally {
    allowRecovery.resolve();
    await page.close();
    await host.stop();
    project.close();
  }
});
