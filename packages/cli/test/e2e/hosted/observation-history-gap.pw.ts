import { expect, test, type Page } from '@playwright/test';
import type { SandboxEvent, SandboxObservationGapEvent } from 'pyric/sandbox';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

test('a late browser receives an explicit history gap and continues observing new writes', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const writerContext = await browser.newContext();
  const lateContext = await browser.newContext();
  const writer = await writerContext.newPage();
  const late = await lateContext.newPage();
  const deliveredIds = new Set<string>();
  const gaps: SandboxObservationGapEvent[] = [];
  let closedSockets = 0;
  let observedAfterGap = false;
  observe(writer, events => {
    for (const event of events) deliveredIds.add(event.id);
  });
  observe(late, events => {
    for (const event of events) {
      const isGap = event.kind === 'observation_gap';
      if (isGap) gaps.push(event);
      const isFollowingWrite = event.kind === 'write' && event.path === 'shared/greeting' && gaps.length > 0;
      if (isFollowingWrite) observedAfterGap = true;
    }
  });
  for (const page of [writer, late]) {
    page.on('websocket', socket => socket.on('close', () => { closedSockets += 1; }));
  }
  try {
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await writer.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      for (const id of ['one', 'two', 'three']) {
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'sized', id), { message: 'é'.repeat(1024 * 1024) });
      }
    });
    await late.goto(fixture.info.url);
    await expect(late.locator('#document')).toHaveText('Empty');
    await expect.poll(() => gaps.length).toBeGreaterThan(0);
    const gap = gaps[0];
    const hasNoGap = gap === undefined;
    if (hasNoGap) throw new Error('The late browser did not receive its history gap');
    expect(gap.omittedCount).toBeGreaterThan(1);
    await expect.poll(() => deliveredIds.has(gap.lastEventId)).toBe(true);
    const uniqueIds = [...deliveredIds];
    const firstIndex = uniqueIds.indexOf(gap.firstEventId);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(uniqueIds.indexOf(gap.lastEventId) - firstIndex + 1).toBe(gap.omittedCount);
    await expect.poll(() => late.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().errors.some(error => {
      return error.code === 'resource-exhausted' && error.method === 'observation-delivery';
    }))).toBe(true);
    await writer.locator('#write').click();
    await expect(writer.locator('#write-result')).toHaveText('Written');
    await expect(late.locator('#document')).toHaveText('Hello from the other browser');
    await expect.poll(() => observedAfterGap).toBe(true);
    expect(closedSockets).toBe(0);
  } finally {
    await Promise.all([writerContext.close(), lateContext.close()]).finally(() => fixture.stop());
  }
});

function observe(page: Page, receive: (events: readonly SandboxEvent[]) => void): void {
  page.on('websocket', socket => socket.on('framereceived', raw => {
    expect(Buffer.byteLength(raw.payload)).toBeLessThanOrEqual(12_582_912);
    const frame: unknown = JSON.parse(raw.payload.toString());
    const isWorkerReply = isBridgeMessage(frame) && frame.type === 'worker-message-result';
    if (isWorkerReply) {
      const message = frame.message;
      const isEventBatch = message.t === 'event';
      if (isEventBatch) receive(message.events);
    }
  }));
}
