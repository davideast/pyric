import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const completion of ['reply', 'failure', 'delete']) {
  test(`browser queued bytes are released after ${completion}`, async ({ browser }) => {
    const fixture = await startStoragePersistenceFixture();
    const requesting = await browser.newPage();
    const healthy = await browser.newPage();
    const held: Array<() => void> = [];
    const messageBytes: number[] = [];
    let refusedFrames = 0;
    let failsReplies = completion === 'failure';
    await requesting.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerFrame) {
          const message = frame.message;
          const isUpload = message.t === 'op' && message.method === 'storage.putBytes';
          if (isUpload) {
            const isHeldUpload = message.path.startsWith('files/held-');
            if (isHeldUpload) {
              messageBytes.push(Buffer.byteLength(JSON.stringify(message)));
              held.push(() => {
                if (failsReplies) {
                  route.send(JSON.stringify({ type: 'worker-message-result', message: {
                    t: 'res', id: message.id, ok: false,
                    error: { code: 'permission-denied', message: 'Controlled peer refusal' },
                  } }));
                  return;
                }
                server.send(raw);
              });
              return;
            }
            const isRefusedUpload = message.path === 'files/refused';
            if (isRefusedUpload) refusedFrames += 1;
          }
        }
        server.send(raw);
      });
      server.onMessage(raw => route.send(raw));
    });
    try {
      for (const page of [requesting, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#ready')).toHaveText('Ready');
      }
      for (const round of ['first', 'second']) {
        messageBytes.length = 0;
        const accepted = requesting.evaluate(async round => {
          const sdk = await import('firebase/storage');
          return Promise.all([0, 1, 2].map(async index => {
            const isLast = index === 2;
            const dataBytes = isLast ? 6 * 1024 * 1024 - 3072 : 6 * 1024 * 1024;
            try {
              await sdk.uploadBytes(sdk.ref(sdk.getStorage(), `files/held-${round}-${index}`),
                new Uint8Array(dataBytes), { customMetadata: { label: 'é' } }).finally(() => {
                  document.documentElement.setAttribute(`data-${round}-${index}`, 'settled');
                });
              return 'completed';
            } catch (error) {
              const hasCode = error !== null && typeof error === 'object' && 'code' in error;
              return hasCode ? error.code : String(error);
            }
          }));
        }, round).catch((error: unknown) => [String(error)]);
        await expect.poll(() => held.length).toBe(3);
        const queuedBytes = messageBytes.reduce((total, bytes) => total + bytes, 0);
        expect(queuedBytes).toBeGreaterThan(24 * 1024 * 1024 - 4096);
        expect(queuedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
        const excess = await requesting.evaluate(async () => {
          const sdk = await import('firebase/storage');
          try {
            await sdk.uploadBytes(sdk.ref(sdk.getStorage(), 'files/refused'), new Uint8Array(8192));
            return 'accepted';
          } catch (error) {
            const hasCode = error !== null && typeof error === 'object' && 'code' in error;
            return hasCode ? error.code : String(error);
          }
        });
        expect(excess).toBe('resource-exhausted');
        expect(refusedFrames).toBe(0);
        await healthy.locator('#value').fill(round);
        await healthy.locator('#save').click();
        await expect(healthy.locator('#saved')).toHaveText('Saved');
        await healthy.locator('#read').click();
        await expect(healthy.locator('#value-read')).toHaveText(round);
        expect(await healthy.evaluate(async () => {
          const sdk = await import('firebase/storage');
          try {
            await sdk.getMetadata(sdk.ref(sdk.getStorage(), 'files/refused'));
            return 'exists';
          } catch (error) {
            const hasCode = error !== null && typeof error === 'object' && 'code' in error;
            return hasCode ? error.code : String(error);
          }
        })).toBe('storage/object-not-found');
        const deletesApp = completion === 'delete';
        if (deletesApp) {
          const repeatedDelete = await requesting.evaluate(async () => {
            const sdk = await import('firebase/app');
            const app = sdk.getApp();
            await sdk.deleteApp(app);
            try {
              await sdk.deleteApp(app);
              return 'deleted again';
            } catch (error) {
              const hasCode = error !== null && typeof error === 'object' && 'code' in error;
              return hasCode ? error.code : String(error);
            }
          });
          expect(repeatedDelete).toBe('app/app-deleted');
          expect(await accepted).toEqual(Array(3).fill('app/app-deleted'));
          await healthy.locator('#value').fill('Healthy after deletion');
          await healthy.locator('#save').click();
          await healthy.locator('#read').click();
          await expect(healthy.locator('#value-read')).toHaveText('Healthy after deletion');
          break;
        }
        held.shift()?.();
        await expect(requesting.locator('html')).toHaveAttribute(`data-${round}-0`, 'settled');
        const replacement = requesting.evaluate(async round => {
          const sdk = await import('firebase/storage');
          try {
            await sdk.uploadBytes(sdk.ref(sdk.getStorage(), `files/held-${round}-replacement`),
              new Uint8Array(6 * 1024 * 1024));
            return 'completed';
          } catch (error) {
            const hasCode = error !== null && typeof error === 'object' && 'code' in error;
            return hasCode ? error.code : String(error);
          }
        }, round).catch((error: unknown) => String(error));
        await expect.poll(() => held.length).toBe(3);
        for (const release of held.splice(0)) release();
        const expected = failsReplies ? 'permission-denied' : 'completed';
        expect(await accepted).toEqual(Array(3).fill(expected));
        expect(await replacement).toBe(expected);
        failsReplies = false;
      }
    } finally {
      await Promise.all([requesting.close(), healthy.close()]).finally(() => fixture.stop());
    }
  });
}
