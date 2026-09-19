import type { Page } from '@playwright/test';

declare global {
  var __pyricFrameObservations: {
    largestFrame: number;
    closedSockets: number;
    barrier: boolean;
    largeObservations: Array<{ size: unknown; hasSample: boolean }>;
  };
}

/** Observe messages delivered to the real browser socket, including routed wire faults. */
export async function observeHostedFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observations: typeof globalThis.__pyricFrameObservations = {
      largestFrame: 0,
      closedSockets: 0,
      barrier: false,
      largeObservations: [],
    };
    globalThis.__pyricFrameObservations = observations;
    const NativeWebSocket = globalThis.WebSocket;
    const utf8 = new TextEncoder();
    function isRecord(value: unknown): value is Record<string, unknown> {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function observe(data: unknown): void {
      const isNonText = typeof data !== 'string';
      if (isNonText) return;
      observations.largestFrame = Math.max(observations.largestFrame, utf8.encode(data).byteLength);
      const frame: unknown = JSON.parse(data);
      const isOtherFrame = !isRecord(frame) || frame.type !== 'worker-message-result';
      if (isOtherFrame) return;
      const message = frame.message;
      const isOtherMessage = !isRecord(message) || message.t !== 'event';
      if (isOtherMessage) return;
      const events = message.events;
      const hasNoEvents = !Array.isArray(events);
      if (hasNoEvents) return;
      for (const event of events) {
        const isNonEvent = !isRecord(event);
        if (isNonEvent) continue;
        const isBarrier = event.kind === 'write' && event.path === 'shared/frame-barrier';
        if (isBarrier) observations.barrier = true;
        const target = event.target;
        const isLargeQuery = isRecord(target) && target.kind === 'query' && target.collection === 'large';
        const isLargeDelivery = event.kind === 'snapshot_delivery' && isLargeQuery;
        if (isLargeDelivery) observations.largeObservations.push({ size: event.size, hasSample: event.sample !== undefined });
      }
    }
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
        super(...args);
        const isOtherSocket = !this.url.endsWith('/__pyric/sandbox');
        if (isOtherSocket) return;
        this.addEventListener('message', event => { observe(event.data); });
        this.addEventListener('close', () => { observations.closedSockets += 1; });
      }
    };
  });
}
