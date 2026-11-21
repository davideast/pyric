import { describe, expect, test } from 'bun:test';
import {
  InMemoryPubSubTopicBus,
  type PubSubPublishedEnvelope,
} from '../../src/functions/pubsub/delivery.js';

describe('InMemoryPubSubTopicBus', () => {
  test('assigns deterministic messageIds, clones envelopes across subscribers, and supports publishWire', async () => {
    let clockMs = Date.parse('2026-11-21T16:00:00.000Z');
    const bus = new InMemoryPubSubTopicBus({
      projectId: 'demo-project',
      now: async () => {
        clockMs += 1_000;
        return clockMs;
      },
    });

    const seenA: PubSubPublishedEnvelope[] = [];
    const seenB: PubSubPublishedEnvelope[] = [];
    let readyCalls = 0;

    const unsubA = bus.subscribe(
      (envelope) => {
        envelope.message.attributes.mutatedByA = 'yes';
        seenA.push(envelope);
        return [
          {
            exportName: 'subA',
            subscription: 'projects/demo-project/subscriptions/subA',
            retry: false,
            startedAt: 1_000,
            durationMs: 2,
            status: 'fulfilled',
          },
        ];
      },
      () => {
        readyCalls += 1;
      },
    );
    const unsubB = bus.subscribe((envelope) => {
      seenB.push(envelope);
      return [
        {
          exportName: 'subB',
          subscription: 'projects/demo-project/subscriptions/subB',
          retry: true,
          startedAt: 1_000,
          durationMs: 3,
          status: 'fulfilled',
        },
      ];
    });

    expect(readyCalls).toBe(1);

    const firstResult = await bus.publish(
      'orders',
      { amount: 50 },
      { channel: 'mobile' },
    );
    expect(firstResult).toEqual({
      messageId: 'pubsub-msg-1',
      publishTime: '2026-11-21T16:00:01.000Z',
      topic: 'orders',
      topicResource: 'projects/demo-project/topics/orders',
      matchedCount: 2,
      deliveries: [
        {
          exportName: 'subA',
          subscription: 'projects/demo-project/subscriptions/subA',
          retry: false,
          startedAt: 1_000,
          durationMs: 2,
          status: 'fulfilled',
        },
        {
          exportName: 'subB',
          subscription: 'projects/demo-project/subscriptions/subB',
          retry: true,
          startedAt: 1_000,
          durationMs: 3,
          status: 'fulfilled',
        },
      ],
    });
    expect(seenB[0]?.message.attributes).toEqual({ channel: 'mobile' });

    unsubA();
    const wireResult = await bus.publishWire({
      topic: 'projects/demo-project/topics/orders',
      dataBase64: Buffer.from('{"wire":true}', 'utf8').toString('base64'),
      attributes: { mode: 'wire' },
      orderingKey: 'ord-key-1',
      messageId: 'custom-wire-id',
      publishTime: '2026-11-21T16:05:00.000Z',
    });

    expect(wireResult.matchedCount).toBe(1);
    expect(wireResult.messageId).toBe('custom-wire-id');
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(2);
    expect(seenB[1]?.message.orderingKey).toBe('ord-key-1');

    unsubB();
    bus.close();
    await expect(bus.publish('orders', { afterClose: true })).rejects.toThrow(
      /closed/,
    );
  });
});
