import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { InMemoryPubSubTopicBus } from '../../src/functions/pubsub/delivery.js';
import { startPubSubTriggerExecution } from '../../src/functions/pubsub/execution.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const pubsubFunctions = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');

describe('startPubSubTriggerExecution', () => {
  test('resolves ready immediately when zero Pub/Sub triggers are exported', async () => {
    const bus = new InMemoryPubSubTopicBus({ projectId: 'demo-project' });
    const host = startPubSubTriggerExecution({
      exported: { helper: () => 'noop' },
      delivery: bus,
      projectId: 'demo-project',
    });

    expect(host.triggerCount).toBe(0);
    await host.ready;
    const result = await bus.publish('unmatched', { ping: true });
    expect(result.matchedCount).toBe(0);
    await host.idle();
    host.close();
  });

  test('rejects ready and invokes onDeliveryError when subscription errors before ready', async () => {
    const { onMessagePublished } = pubsubFunctions;
    const expectedError = new Error('pubsub bus init failure');
    const reported: Array<{ exportName: string; error: unknown }> = [];

    const host = startPubSubTriggerExecution({
      exported: {
        onOrder: onMessagePublished('orders', () => undefined),
      },
      projectId: 'demo-project',
      delivery: {
        subscribe(_listener, _onReady, onError) {
          onError?.(expectedError);
          return () => undefined;
        },
      },
      onDeliveryError(error, trigger) {
        reported.push({ exportName: trigger.exportName, error });
      },
    });

    await expect(host.ready).rejects.toBe(expectedError);
    expect(reported).toEqual([{ exportName: 'onOrder', error: expectedError }]);
    host.close();
  });

  test('fans out concurrently across matching short and qualified subscribers without blocking on slow or throwing siblings', async () => {
    const { onMessagePublished } = pubsubFunctions;
    const timeline: string[] = [];
    const { promise: slowGate, resolve: releaseSlowGate } =
      Promise.withResolvers<void>();

    const slowSubscriber = onMessagePublished('orders', async (event) => {
      const body = event.data.message.json as { seq: number };
      timeline.push(`slow:start:${body.seq}`);
      event.data.message.attributes.mutatedInSlow = 'true';
      if (body.seq === 1) {
        await slowGate;
      }
      timeline.push(`slow:end:${body.seq}`);
    });

    const fastQualifiedSubscriber = onMessagePublished(
      {
        topic: 'projects/demo-project/topics/orders',
        region: 'europe-west1',
      },
      (event) => {
        const body = event.data.message.json as { seq: number };
        timeline.push(
          `fast:${body.seq}:mutated=${String(event.data.message.attributes.mutatedInSlow)}`,
        );
      },
    );

    const failingSubscriber = onMessagePublished('orders', () => {
      timeline.push('failing:throw');
      throw new Error('SUBSCRIBER_BOOM');
    });

    const otherTopicSubscriber = onMessagePublished('invoices', () => {
      timeline.push('invoices:unexpected');
    });

    const foreignProjectSubscriber = onMessagePublished(
      'projects/foreign-proj/topics/orders',
      () => {
        timeline.push('foreign:unexpected');
      },
    );

    const bus = new InMemoryPubSubTopicBus({ projectId: 'demo-project' });
    const outcomes: Array<{ exportName: string; status: string }> = [];
    const host = startPubSubTriggerExecution({
      exported: {
        slowSubscriber,
        fastQualifiedSubscriber,
        failingSubscriber,
        otherTopicSubscriber,
        foreignProjectSubscriber,
      },
      delivery: bus,
      projectId: 'demo-project',
      onExecution(result, trigger) {
        outcomes.push({ exportName: trigger.exportName, status: result.status });
      },
    });

    expect(host.triggerCount).toBe(5);
    await host.ready;

    // Publish 1 blocks slowSubscriber on slowGate, while fastQualifiedSubscriber
    // and failingSubscriber run concurrently and Publish 2 finishes without waiting on Publish 1!
    const publish1Promise = bus.publish(
      'orders',
      { seq: 1 },
      { env: 'test' },
    );
    const publish2Promise = bus.publish(
      'projects/demo-project/topics/orders',
      { seq: 2 },
      { env: 'test' },
    );
    const unmatchedResult = await bus.publish('unregistered-topic', { seq: 99 });
    expect(unmatchedResult.matchedCount).toBe(0);

    const publish2Result = await publish2Promise;
    expect(publish2Result.matchedCount).toBe(3);
    expect(timeline).toContain('slow:start:1');
    expect(timeline).toContain('fast:1:mutated=undefined');
    expect(timeline).toContain('fast:2:mutated=undefined');
    expect(timeline).toContain('slow:end:2');
    expect(timeline).not.toContain('slow:end:1');
    expect(timeline).not.toContain('invoices:unexpected');
    expect(timeline).not.toContain('foreign:unexpected');

    releaseSlowGate();
    const publish1Result = await publish1Promise;
    await host.idle();

    expect(publish1Result.deliveries.map((d) => ({
      exportName: d.exportName,
      status: d.status,
      errorMessage: d.error?.message,
    }))).toEqual([
      { exportName: 'slowSubscriber', status: 'fulfilled', errorMessage: undefined },
      {
        exportName: 'fastQualifiedSubscriber',
        status: 'fulfilled',
        errorMessage: undefined,
      },
      {
        exportName: 'failingSubscriber',
        status: 'rejected',
        errorMessage: 'SUBSCRIBER_BOOM',
      },
    ]);
    expect(outcomes).toHaveLength(6);

    host.close();
    const afterClose = await bus.publish('orders', { seq: 3 });
    expect(afterClose.matchedCount).toBe(0);
    expect(outcomes).toHaveLength(6);
  });

  test('preserves FIFO order per trigger for messages sharing a non-empty orderingKey while keeping distinct keys concurrent', async () => {
    const { onMessagePublished } = pubsubFunctions;
    const events: string[] = [];
    const { promise: keyAGate, resolve: releaseKeyA } =
      Promise.withResolvers<void>();

    const onLedger = onMessagePublished('ledger', async (event) => {
      const payload = event.data.message.json as { step: string };
      events.push(`start:${event.data.message.orderingKey}:${payload.step}`);
      if (event.data.message.orderingKey === 'acct-A' && payload.step === '1') {
        await keyAGate;
      }
      events.push(`end:${event.data.message.orderingKey}:${payload.step}`);
    });

    const bus = new InMemoryPubSubTopicBus({ projectId: 'demo-project' });
    const host = startPubSubTriggerExecution({
      exported: { onLedger },
      delivery: bus,
      projectId: 'demo-project',
    });
    await host.ready;

    const a1 = bus.publish('ledger', { step: '1' }, { orderingKey: 'acct-A' });
    const a2 = bus.publish('ledger', { step: '2' }, { orderingKey: 'acct-A' });
    const b1 = await bus.publish('ledger', { step: '1' }, { orderingKey: 'acct-B' });

    expect(b1.matchedCount).toBe(1);
    expect(events).toEqual([
      'start:acct-A:1',
      'start:acct-B:1',
      'end:acct-B:1',
    ]);

    releaseKeyA();
    await Promise.all([a1, a2]);
    await host.idle();

    expect(events).toEqual([
      'start:acct-A:1',
      'start:acct-B:1',
      'end:acct-B:1',
      'end:acct-A:1',
      'start:acct-A:2',
      'end:acct-A:2',
    ]);

    host.close();
  });
});
