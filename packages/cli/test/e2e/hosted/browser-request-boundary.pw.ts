import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import type { SandboxObservationGapEvent } from 'pyric/sandbox';
import { startHostedFixture } from './fixture.js';

for (const expectedBytes of [12_582_911, 12_582_912, 12_582_913]) {
  test(`browser write admission preserves the ${expectedBytes}-byte UTF-8 boundary`, async ({ browser }) => {
    const fixture = await startHostedFixture();
    const requestingContext = await browser.newContext();
    const healthyContext = await browser.newContext();
    const requesting = await requestingContext.newPage();
    const healthy = await healthyContext.newPage();
    const writeBytes: number[] = [];
    const gaps: SandboxObservationGapEvent[] = [];
    let largestReplyBytes = 0;
    let observedAfterGap = false;
    let closedSockets = 0;
    healthy.on('websocket', socket => socket.on('close', () => { closedSockets += 1; }));
    requesting.on('websocket', socket => {
      socket.on('close', () => { closedSockets += 1; });
      socket.on('framesent', raw => {
        const frame: unknown = JSON.parse(raw.payload.toString());
        const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerFrame) {
          const message = frame.message;
          const isWrite = message.t === 'op' && message.method === 'setDoc';
          if (isWrite) writeBytes.push(Buffer.byteLength(raw.payload));
        }
      });
      socket.on('framereceived', raw => {
        largestReplyBytes = Math.max(largestReplyBytes, Buffer.byteLength(raw.payload));
        const frame: unknown = JSON.parse(raw.payload.toString());
        const isWorkerReply = isBridgeMessage(frame) && frame.type === 'worker-message-result';
        if (isWorkerReply) {
          const message = frame.message;
          const isEventBatch = message.t === 'event';
          if (isEventBatch) {
            for (const event of message.events) {
              const isGap = event.kind === 'observation_gap';
              if (isGap) gaps.push(event);
              const isHealthyWrite = event.kind === 'write' && event.path === 'shared/greeting';
              const followsGap = isHealthyWrite && gaps.length > 0;
              if (followsGap) observedAfterGap = true;
            }
          }
        }
      });
    });
    try {
      for (const page of [requesting, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
      }
      await requesting.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'sized/boundary'), { message: '', marker: 'baseline' });
      });
      await expect.poll(() => writeBytes.length).toBe(1);
      // Measure the public wire envelope; the equal-length marker keeps it stable.
      const emptyFrameBytes = writeBytes[0];
      const missingCalibration = emptyFrameBytes === undefined;
      if (missingCalibration) throw new Error('The baseline write did not reach the socket');
      const outcome = await requesting.evaluate(async payloadBytes => {
        const sdk = await import('firebase/firestore');
        const message = 'é'.repeat(Math.floor(payloadBytes / 2)) + 'x'.repeat(payloadBytes % 2);
        try {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'sized/boundary'), { message, marker: 'accepted' });
          return 'accepted';
        } catch (error) {
          const hasCode = typeof error === 'object' && error !== null && 'code' in error;
          return hasCode ? error.code : 'unknown';
        }
      }, expectedBytes - emptyFrameBytes);
      const exceedsLimit = expectedBytes > 12_582_912;
      let expectedCount = 1;
      if (exceedsLimit) {
        expect(outcome).toBe('resource-exhausted');
        expect(writeBytes).toEqual([emptyFrameBytes]);
        expectedCount = 0;
      } else {
        expect(outcome).toBe('accepted');
        expect(writeBytes).toEqual([emptyFrameBytes, expectedBytes]);
        for (const page of [requesting, healthy]) {
          await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().errors.some(error => {
            return error.code === 'resource-exhausted' && error.method === 'observation-delivery';
          }))).toBe(true);
        }
      }
      const count = await healthy.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const selected = sdk.query(sdk.collection(sdk.getFirestore(), 'sized'), sdk.where('marker', '==', 'accepted'));
        return (await sdk.getCountFromServer(selected)).data().count;
      });
      expect(count).toBe(expectedCount);
      const wasAccepted = !exceedsLimit;
      if (wasAccepted) {
        expect(gaps.length).toBeGreaterThan(0);
        for (const gap of gaps) {
          expect(gap.reason).toBe('frame-limit');
          expect(gap.omittedCount).toBe(1);
          expect(gap.firstEventId.length).toBeGreaterThan(0);
          expect(gap.lastEventId).toBe(gap.firstEventId);
        }
      }
      for (const page of [healthy, requesting]) {
        await page.locator('#write').click();
        await expect(page.locator('#write-result')).toHaveText('Written');
      }
      if (wasAccepted) await expect.poll(() => observedAfterGap).toBe(true);
      expect(largestReplyBytes).toBeLessThanOrEqual(12_582_912);
      expect(closedSockets).toBe(0);
    } finally {
      await Promise.all([requestingContext.close(), healthyContext.close()]).finally(() => fixture.stop());
    }
  });
}
