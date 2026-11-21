import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { InMemoryStorageTriggerDelivery } from '../../src/functions/storage/delivery.js';
import { startStorageTriggerExecution } from '../../src/functions/storage/execution.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const storageFunctions = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');

describe('startStorageTriggerExecution', () => {
  test('resolves ready immediately when zero active Storage triggers are exported', async () => {
    const delivery = new InMemoryStorageTriggerDelivery();
    const host = startStorageTriggerExecution({
      exported: { helper: () => 'noop' },
      delivery,
      eventOptions: () => ({
        id: 'unused',
        time: '2026-11-21T00:00:00.000Z',
        location: 'us-central1',
      }),
    });

    expect(host.triggerCount).toBe(0);
    await host.ready;
    await host.idle();
    host.close();
  });

  test('rejects ready and notifies onDeliveryError when subscription fails before ready', async () => {
    const { onObjectFinalized } = storageFunctions;
    const expectedError = new Error('storage relay unavailable');
    const reportedErrors: Array<{ exportName: string; error: unknown }> = [];

    const host = startStorageTriggerExecution({
      exported: {
        onUpload: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, () => undefined),
      },
      defaultBucket: 'demo-project.appspot.com',
      delivery: {
        subscribe(_listener, _onReady, onError) {
          onError?.(expectedError);
          return () => undefined;
        },
      },
      eventOptions: () => ({
        id: 'unused',
        time: '2026-11-21T00:00:00.000Z',
        location: 'us-central1',
      }),
      onDeliveryError(error, trigger) {
        reportedErrors.push({ exportName: trigger.exportName, error });
      },
    });

    await expect(host.ready).rejects.toBe(expectedError);
    expect(reportedErrors).toEqual([{ exportName: 'onUpload', error: expectedError }]);
    host.close();
  });

  test('serializes handler runs, routes buckets accurately, ignores rollbacks, and stops on close', async () => {
    const { onObjectFinalized } = storageFunctions;
    const order: string[] = [];
    const { promise: firstGate, resolve: releaseFirst } = Promise.withResolvers<void>();

    const onDefault = onObjectFinalized(
      { bucket: 'demo-project.appspot.com' },
      async (event) => {
        order.push(`default:start:${event.data.name}`);
        if (event.data.name === 'items/first.txt') {
          await firstGate;
        }
        order.push(`default:end:${event.data.name}`);
      },
    );
    const onCustom = onObjectFinalized(
      { bucket: 'custom-bucket', region: 'europe-west1' },
      (event) => {
        order.push(`custom:${event.location}:${event.bucket}:${event.data.name}`);
      },
    );

    const delivery = new InMemoryStorageTriggerDelivery({
      defaultBucket: 'demo-project.appspot.com',
    });
    const outcomes: Array<{ exportName: string; status: string; bucket: string }> = [];

    const host = startStorageTriggerExecution({
      exported: { onDefault, onCustom },
      defaultBucket: 'demo-project.appspot.com',
      delivery,
      eventOptions: async (_projected, sequence, trigger) => {
        await Promise.resolve();
        return {
          id: `evt-${sequence}`,
          time: '2026-11-21T12:00:00.000Z',
          location: trigger.location ?? 'us-central1',
        };
      },
      onExecution(result, trigger, projected) {
        outcomes.push({
          exportName: trigger.exportName,
          status: result.status,
          bucket: projected.bucket,
        });
      },
    });

    expect(host.triggerCount).toBe(2);
    await host.ready;

    const makeSnap = (fullPath: string, bucket: string) => ({
      fullPath,
      bucket,
      generation: '1',
      metageneration: '1',
      timeCreated: '2026-11-21T12:00:00.000Z',
      updated: '2026-11-21T12:00:00.000Z',
      size: 4,
    });

    // Rollback-marked mutation must not trigger any handler.
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/rolled-back.txt',
      at: 100,
      rollback: true,
      after: makeSnap('items/rolled-back.txt', 'demo-project.appspot.com'),
    });

    // First default-bucket upload blocks on firstGate; second default + custom wait behind it.
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'pyric-default',
      path: 'items/first.txt',
      at: 101,
      after: makeSnap('items/first.txt', 'pyric-default'),
    });
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/second.txt',
      at: 102,
      after: makeSnap('items/second.txt', 'demo-project.appspot.com'),
    });
    delivery.emit({
      op: 'object_put',
      storeBucket: 'custom-bucket',
      bucketName: 'custom-bucket',
      path: 'exports/archive.tar',
      at: 103,
      after: makeSnap('exports/archive.tar', 'custom-bucket'),
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(order).toEqual(['default:start:items/first.txt']);

    releaseFirst();
    await host.idle();

    expect(order).toEqual([
      'default:start:items/first.txt',
      'default:end:items/first.txt',
      'default:start:items/second.txt',
      'default:end:items/second.txt',
      'custom:europe-west1:custom-bucket:exports/archive.tar',
    ]);
    expect(outcomes).toEqual([
      { exportName: 'onDefault', status: 'fulfilled', bucket: 'demo-project.appspot.com' },
      { exportName: 'onDefault', status: 'fulfilled', bucket: 'demo-project.appspot.com' },
      { exportName: 'onCustom', status: 'fulfilled', bucket: 'custom-bucket' },
    ]);

    host.close();
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/after-close.txt',
      at: 104,
      after: makeSnap('items/after-close.txt', 'demo-project.appspot.com'),
    });
    await host.idle();
    expect(outcomes).toHaveLength(3);
  });
});
