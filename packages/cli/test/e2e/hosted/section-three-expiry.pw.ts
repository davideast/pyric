import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSectionThreeFixture } from './section-three-fixture.js';

test('hosted RTDB disconnect intent is consumed before expiry and fresh intent works after readmission', async ({ page, context }) => {
  test.setTimeout(90_000);
  const fixture = await startSectionThreeFixture(['--hosted', '--no-capture']);
  let interrupted = false;
  let cutConnection: (() => Promise<void>) | undefined;
  const grants: string[] = [];
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      let ownerGrant: string | undefined;
      route.onMessage(async data => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        const registersIntent = isBridgeFrame && frame.type === 'worker-message'
          && frame.message.t === 'op' && frame.message.method === 'rtdb.onDisconnectUpdate';
        if (registersIntent) {
          cutConnection = async () => {
            const grant = ownerGrant;
            const hasNoGrant = grant === undefined;
            if (hasNoGrant) throw new Error('Owner has no admitted session');
            grants.push(grant);
            interrupted = true;
            await route.close({ code: 1001, reason: 'Hold RTDB owner past retention' });
            await server.close();
          };
        }
        server.send(data);
      });
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const acknowledgesAttach = isBridgeMessage(frame) && frame.type === 'attach-ack';
        if (acknowledgesAttach) {
          ownerGrant = frame.resumeToken;
          if (interrupted) grants.push(frame.resumeToken ?? 'missing');
        }
        route.send(data);
      });
    });
    await page.clock.install();
    await page.goto(fixture.info.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.locator('#arm').click();
    await expect(page.locator('#result')).toHaveText('Done');
    const cut = cutConnection;
    const hasNoConnection = cut === undefined;
    if (hasNoConnection) throw new Error('Owner never registered disconnect intent');
    await page.clock.pauseAt(new Date());
    await cut();
    await expect(page.locator('#connected')).toHaveText('false');
    await expect(page.locator('#presence')).toHaveText('{"state":"offline","untouched":"disconnected","executions":1}');
    await expect(page.locator('#observer-connected')).toHaveText('true');
    await page.locator('#returned').click();
    await expect(page.locator('#presence')).toHaveText('{"state":"returned","untouched":"disconnected","executions":1}');
    // Host retention is 60 seconds; the browser cannot resume until released.
    await new Promise(resolve => setTimeout(resolve, 62_000));
    await page.clock.resume();
    await expect(page.locator('#connected')).toHaveText('true');
    await expect.poll(() => grants.length).toBe(2);
    expect(grants[1]).not.toBe(grants[0]);
    expect(grants[1]).not.toBe('missing');
    await expect(page.locator('#presence')).toHaveText('{"state":"returned","untouched":"disconnected","executions":1}');
    await page.locator('#arm').click();
    await expect(page.locator('#result')).toHaveText('Done');
    await page.locator('#delete').click();
    await expect(page.locator('#result')).toHaveText('Done');
    await expect(page.locator('#presence')).toHaveText('{"state":"offline","untouched":"disconnected","executions":1}');
  } finally {
    await page.clock.resume();
    await page.close();
    await fixture.stop();
  }
});
