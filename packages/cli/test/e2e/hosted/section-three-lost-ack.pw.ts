import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSectionThreeFixture } from './section-three-fixture.js';

test('a lost RTDB increment acknowledgment is not replayed and the original client can write after recovery', async ({ page, context }) => {
  const fixture = await startSectionThreeFixture(['--hosted', '--no-capture']);
  let incrementId: string | undefined;
  let incrementRequests = 0;
  let droppedReply = false;
  const restored = Promise.withResolvers<void>();
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isWorkerRequest = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerRequest) {
          const request = frame.message;
          const isSet = request.t === 'op' && request.method === 'rtdb.set';
          if (isSet) {
            const isIncrement = request.path === '/counters/uncertain' && request.value !== 0;
            if (isIncrement) {
              incrementId = request.id;
              incrementRequests += 1;
            }
          }
        }
        server.send(data);
      });
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        const isWorkerReply = isBridgeFrame && frame.type === 'worker-message-result';
        const isIncrementReply = isWorkerReply && frame.message.t === 'res' && frame.message.id === incrementId;
        const dropsFirstReply = isIncrementReply && !droppedReply;
        if (dropsFirstReply) {
          droppedReply = true;
          void route.close({ code: 1001, reason: 'Drop committed RTDB increment acknowledgment' });
          void server.close();
          return;
        }
        const isRestored = isBridgeFrame && frame.type === 'attach-ack' && droppedReply;
        if (isRestored) restored.resolve();
        route.send(data);
      });
    });
    await page.goto(`${fixture.info.url}/concurrent.html`);
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.locator('#increment').click();
    await expect(page.locator('#result')).toHaveText(
      'unavailable: The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.',
    );
    await restored.promise;
    await page.locator('#read').click();
    await expect(page.locator('#result')).toHaveText('{"count":1}');
    expect(incrementRequests).toBe(1);
    await page.locator('#increment').click();
    await expect(page.locator('#result')).toHaveText('"Acknowledged"');
    await page.locator('#read').click();
    await expect(page.locator('#result')).toHaveText('{"count":2}');
    expect(incrementRequests).toBe(2);
  } finally {
    await page.close();
    await fixture.stop();
  }
});
