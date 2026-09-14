import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

for (const completion of ['reply', 'failure', 'delete']) {
  test(`a browser refuses operation 257 and releases capacity on ${completion}`, async ({ browser }) => {
    const fixture = await startHostedFixture();
    const requesting = await browser.newPage();
    const healthy = await browser.newPage();
    const heldReads: Array<() => void> = [];
    let holdingReads = false;
    let refusedWriteFrames = 0;
    await requesting.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerFrame) {
          const message = frame.message;
          const isHeldRead = holdingReads && message.t === 'op' && message.method === 'getDoc';
          if (isHeldRead) {
            heldReads.push(() => {
              const failsOperation = completion === 'failure';
              if (failsOperation) {
                route.send(JSON.stringify({ type: 'worker-message-result', message: {
                  t: 'res', id: message.id, ok: false, error: { code: 'unavailable', message: 'Controlled reply failure' },
                } }));
              } else {
                server.send(raw);
              }
            });
            return;
          }
          const isRefusedWrite = message.t === 'op' && message.method === 'setDoc' && message.path === 'limit/refused';
          if (isRefusedWrite) refusedWriteFrames += 1;
        }
        server.send(raw);
      });
      server.onMessage(raw => route.send(raw));
    });
    try {
      for (const page of [requesting, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
      }
      holdingReads = true;
      const accepted = requesting.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const target = sdk.doc(sdk.getFirestore(), 'shared/greeting');
        const reads = Array.from({ length: 256 }, async () => {
          try {
            await sdk.getDoc(target);
            return 'completed';
          } catch (error) {
            const hasCode = error !== null && typeof error === 'object' && 'code' in error;
            return hasCode ? error.code : String(error);
          }
        });
        return Promise.all(reads);
      }).then(values => ({ kind: 'completed', values }), error => ({ kind: 'failed', error: String(error) }));
      await expect.poll(() => heldReads.length).toBe(256);
      const excess = await requesting.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        try {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'limit/refused'), { message: 'Must not be written' });
          return 'accepted';
        } catch (error) {
          const hasCode = error !== null && typeof error === 'object' && 'code' in error;
          return hasCode ? error.code : String(error);
        }
      });
      expect(excess).toBe('resource-exhausted');
      expect(refusedWriteFrames).toBe(0);
      await healthy.locator('#write').click();
      await expect(healthy.locator('#write-result')).toHaveText('Written');
      expect(await healthy.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/refused'))).exists();
      })).toBe(false);
      const deletesApp = completion === 'delete';
      if (deletesApp) {
        await requesting.evaluate(async () => {
          const sdk = await import('firebase/app');
          await sdk.deleteApp(sdk.getApp());
        });
        expect(await accepted).toEqual({ kind: 'completed', values: Array(256).fill('app/app-deleted') });
        const writtenAfterDelete = await healthy.evaluate(async () => {
          const sdk = await import('firebase/firestore');
          const target = sdk.doc(sdk.getFirestore(), 'limit/healthy');
          await sdk.setDoc(target, { message: 'Still healthy after deletion' });
          return (await sdk.getDoc(target)).data()?.message;
        });
        expect(writtenAfterDelete).toBe('Still healthy after deletion');
        return;
      }
      holdingReads = false;
      for (const release of heldReads.splice(0)) release();
      const result = await accepted;
      const failsOperation = completion === 'failure';
      const expectedResult = failsOperation ? 'unavailable' : 'completed';
      expect(result).toEqual({ kind: 'completed', values: Array(256).fill(expectedResult) });
      await requesting.locator('#write').click();
      await expect(requesting.locator('#write-result')).toHaveText('Written');
    } finally {
      await Promise.all([requesting.close(), healthy.close()]).finally(() => fixture.stop());
    }
  });
}
