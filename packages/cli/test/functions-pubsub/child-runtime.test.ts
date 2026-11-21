import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  sendChildPublishPubSub,
  startPubSubChildRuntime,
} from '../../src/functions/pubsub/child-runtime.js';
import { createRemoteSandboxHandle } from '../../src/remote/index.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const pubsubFunctions = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');

describe('startPubSubChildRuntime', () => {
  test('uses sandbox clock timestamps, emits fulfilled and rejected IPC events, and closes cleanly', async () => {
    const { onMessagePublished } = pubsubFunctions;
    const ipcEvents: FunctionsChildEvent[] = [];
    const seenPublishTimes: string[] = [];
    const fixedClockMs = Date.parse('2026-11-21T18:30:00.000Z');

    const sandbox = createRemoteSandboxHandle({
      serveUrl: 'http://127.0.0.1:4500',
      close() {},
      channel: {
        async op(payload) {
          if (payload.method === 'sandbox.clock') {
            return { now: fixedClockMs };
          }
          return {};
        },
        subscribe() {
          return () => undefined;
        },
      },
    });

    const onGood = onMessagePublished('events', (event) => {
      seenPublishTimes.push(event.data.message.publishTime);
      return event.data.message.json;
    });
    const onBadJson = onMessagePublished('raw-bytes', (event) => {
      return event.data.message.json;
    });

    const runtimeHost = startPubSubChildRuntime({
      exported: { onGood, onBadJson },
      sandbox,
      projectId: 'demo-project',
      location: 'us-central1',
      send: (event) => ipcEvents.push(event),
    });

    expect(runtimeHost.triggerCount).toBe(2);
    expect(runtimeHost.triggers.map((t) => t.exportName)).toEqual([
      'onGood',
      'onBadJson',
    ]);
    await runtimeHost.ready;

    const goodReceipt = await runtimeHost.publish(
      'events',
      { ok: true },
      { traceId: 'tr-1' },
    );
    expect(goodReceipt.publishTime).toBe('2026-11-21T18:30:00.000Z');
    expect(seenPublishTimes).toEqual(['2026-11-21T18:30:00.000Z']);

    const badReceipt = await runtimeHost.publish(
      'raw-bytes',
      new Uint8Array([0xff, 0x00, 0xfe]),
    );
    expect(badReceipt.deliveries[0]?.status).toBe('rejected');
    expect(badReceipt.deliveries[0]?.error?.message).toContain(
      'Unable to parse Pub/Sub message data as JSON:',
    );

    await runtimeHost.idle();
    expect(ipcEvents).toHaveLength(2);
    expect(ipcEvents[0]).toEqual({
      type: 'execution',
      exportName: 'onGood',
      ref: 'projects/demo-project/topics/events',
      params: { topic: 'events' },
      status: 'fulfilled',
    });
    expect(ipcEvents[1]).toMatchObject({
      type: 'execution',
      exportName: 'onBadJson',
      ref: 'projects/demo-project/topics/raw-bytes',
      params: { topic: 'raw-bytes' },
      status: 'rejected',
    });

    runtimeHost.close();
  });

  test('rejects in-flight sendChildPublishPubSub and cleans up listeners if child disconnects or closes', async () => {
    const emitter = new EventEmitter();
    const fakeChild = Object.assign(emitter, {
      exitCode: null,
      signalCode: null,
      connected: true,
      send(_msg: unknown, cb?: (err: Error | null) => void) {
        cb?.(null);
        return true;
      },
    }) as unknown as ChildProcess;

    const pending = sendChildPublishPubSub(fakeChild, 'orders', { id: 1 }, { env: 'test' });
    expect(emitter.listenerCount('message')).toBe(1);
    emitter.emit('disconnect');
    await expect(pending).rejects.toThrow(/disconnected while publishing/);
    expect(emitter.listenerCount('message')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
    expect(emitter.listenerCount('disconnect')).toBe(0);

    const disconnectedChild = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      connected: false,
      send: () => true,
    }) as unknown as ChildProcess;
    await expect(
      sendChildPublishPubSub(disconnectedChild, 'orders', { id: 2 }),
    ).rejects.toThrow(/disconnected/);
  });
});
