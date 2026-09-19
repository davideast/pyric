import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

for (const deletesDuringRecovery of [false, true]) {
  test(`silent hosted connection recovery preserves write intent and app deletion (delete during recovery: ${deletesDuringRecovery})`, async ({ browser }) => {
    const fixture = await startHostedFixture();
    const affected = await browser.newContext();
    const healthy = await browser.newContext();
    let closedConnections = 0;
    let heldConnections = 0;
    let writeRequests = 0;
    let heldPings = 0;
    let healthyPongs = 0;
    let appPings = 0;
    let reconnectAttempts = 0;
    let connections = 0;
    let affectedGrant: string | undefined;
    try {
      await affected.addInitScript(() => {
        const NativeWebSocket = WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            // Recovery must not wait for the browser to deliver a close event.
            this.addEventListener('close', event => event.stopImmediatePropagation());
          }
        };
      });
      await affected.routeWebSocket('**/*', route => {
        connections += 1;
        const server = route.connectToServer();
        let losesReplies = false;
        let sessionGrant: string | undefined;
        route.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const isFrame = isBridgeMessage(frame);
          const isWorkerMessage = isFrame && frame.type === 'worker-message';
          if (isWorkerMessage) {
            const operation = frame.message;
            const isWrite = operation.t === 'op' && operation.method === 'setDoc' && operation.path === 'shared/greeting';
            if (isWrite) {
              writeRequests += 1;
              losesReplies = true;
              affectedGrant = sessionGrant;
              heldConnections += 1;
            }
          }
          const isHeldPing = losesReplies && isFrame && frame.type === 'ping';
          if (isHeldPing) heldPings += 1;
          const isAppPing = isFrame && frame.type === 'ping' && affectedGrant !== undefined && sessionGrant === affectedGrant;
          if (isAppPing) appPings += 1;
          const resumesAffectedApp = isFrame && frame.type === 'attach' && affectedGrant !== undefined && frame.resumeToken === affectedGrant;
          if (resumesAffectedApp) reconnectAttempts += 1;
          server.send(data);
        });
        server.onMessage(data => {
          if (losesReplies) return;
          const frame: unknown = JSON.parse(data.toString());
          const isFrame = isBridgeMessage(frame);
          const isAttach = isFrame && frame.type === 'attach-ack';
          if (isAttach) sessionGrant = frame.resumeToken;
          const isPong = isFrame && frame.type === 'pong';
          if (isPong) healthyPongs += 1;
          route.send(data);
        });
        route.onClose(() => {
          if (losesReplies) closedConnections += 1;
          server.close();
        });
      });
      const page = await affected.newPage();
      const observer = await healthy.newPage();
      await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
      await page.goto(fixture.info.url);
      await observer.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect(observer.locator('#document')).toHaveText('Empty');
      async function advanceResponsiveMinute(): Promise<void> {
        for (const _interval of [1, 2, 3, 4]) {
          const previousPongs = healthyPongs;
          await page.clock.runFor(15_000);
          await expect.poll(() => healthyPongs).toBeGreaterThan(previousPongs);
        }
      }
      // An idle but responsive host must remain usable across multiple deadlines.
      await advanceResponsiveMinute();
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const output = document.querySelector('#write-result');
        const hasNoOutput = output === null;
        if (hasNoOutput) throw new Error('Missing write result output.');
        output.textContent = 'Pending';
        void sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), {
          message: 'Committed before silence', count: sdk.increment(1),
        }).then(() => { output.textContent = 'Written'; }, (error: unknown) => {
          const hasCode = error instanceof Error && 'code' in error;
          output.textContent = hasCode ? String(error.code) : String(error);
        });
      });
      await expect(observer.locator('#document')).toHaveText('Committed before silence');
      expect(heldConnections).toBe(1);
      await expect(page.locator('#write-result')).toHaveText('Pending');
      await page.clock.runFor(14_999);
      expect(heldPings).toBe(0);
      await page.clock.runFor(1);
      await expect.poll(() => heldPings).toBe(1);
      await page.clock.runFor(15_000);
      await expect.poll(() => heldPings).toBe(2);
      await page.clock.runFor(14_999);
      expect(closedConnections).toBe(0);
      await page.clock.runFor(1);
      await expect(page.locator('#write-result')).toHaveText('unavailable');
      await expect.poll(() => closedConnections).toBe(1);
      expect(heldPings).toBe(2);
      if (deletesDuringRecovery) {
        await page.evaluate(async () => {
          const { deleteApp, getApp } = await import('firebase/app');
          await deleteApp(getApp());
        });
        const connectionsBeforeDeletion = connections;
        await advanceResponsiveMinute();
        expect(connections).toBe(connectionsBeforeDeletion);
        expect(reconnectAttempts).toBe(0);
        expect(appPings).toBe(2);
        expect(writeRequests).toBe(1);
        await observer.getByRole('button', { name: 'Write shared document' }).click();
        await expect(observer.locator('#write-result')).toHaveText('Written');
        await expect(page.locator('#document')).toHaveText('Listener failed: The operation was aborted.');
        return;
      }
      await page.clock.runFor(300);
      await expect(page.locator('#document')).toHaveText('Committed before silence');
      expect(reconnectAttempts).toBe(1);
      const count = await observer.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'))).data()?.count;
      });
      expect(count).toBe(1);
      await observer.getByRole('button', { name: 'Write shared document' }).click();
      await expect(observer.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      expect(writeRequests).toBe(1);
      await page.clock.runFor(15_000);
      await expect.poll(() => appPings).toBe(3);
      await page.evaluate(async () => {
        const { deleteApp, getApp } = await import('firebase/app');
        await deleteApp(getApp());
      });
      const pingsBeforeDeletion = appPings;
      const connectionsBeforeDeletion = connections;
      await advanceResponsiveMinute();
      expect(connections).toBe(connectionsBeforeDeletion);
      expect(appPings).toBe(pingsBeforeDeletion);
      expect(reconnectAttempts).toBe(1);
    } finally {
      await affected.close();
      await healthy.close();
      await fixture.stop();
    }
  });
}
