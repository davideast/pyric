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

  test('projects finalized, metadataUpdated, archived + finalized on overwrite, and deleted with timeDeleted', async () => {
    const {
      onObjectFinalized,
      onObjectMetadataUpdated,
      onObjectArchived,
      onObjectDeleted,
    } = storageFunctions;

    const observed: Array<Record<string, unknown>> = [];
    const capture = (label: string) => (event: {
      type: string;
      time: string;
      data: {
        name: string;
        generation: string;
        metageneration: string;
        size: string;
        updated: string;
        timeDeleted?: string;
        metadata?: Record<string, string>;
      };
    }) => {
      observed.push({
        label,
        type: event.type,
        time: event.time,
        name: event.data.name,
        generation: event.data.generation,
        metageneration: event.data.metageneration,
        size: event.data.size,
        updated: event.data.updated,
        hasTimeDeleted: 'timeDeleted' in event.data,
        timeDeleted: event.data.timeDeleted ?? null,
        metadata: event.data.metadata ?? null,
      });
    };

    const delivery = new InMemoryStorageTriggerDelivery({
      defaultBucket: 'demo-project.appspot.com',
    });

    // Export finalized BEFORE archived to verify overwrite still orders archived(v1) before finalized(v2).
    const host = startStorageTriggerExecution({
      exported: {
        onFinalized: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, capture('finalized')),
        onMetadata: onObjectMetadataUpdated({ bucket: 'demo-project.appspot.com' }, capture('metadata')),
        onArchived: onObjectArchived({ bucket: 'demo-project.appspot.com' }, capture('archived')),
        onDeleted: onObjectDeleted({ bucket: 'demo-project.appspot.com' }, capture('deleted')),
      },
      defaultBucket: 'demo-project.appspot.com',
      delivery,
      eventOptions: (projected, sequence) => {
        let isoTime = '2026-11-21T15:00:00.000Z';
        if (projected.at > 0) {
          isoTime = new Date(projected.at).toISOString();
        }
        return {
          id: `lc-${sequence}`,
          time: isoTime,
          location: 'us-central1',
        };
      },
    });

    expect(host.triggerCount).toBe(4);
    await host.ready;

    const v1 = {
      fullPath: 'docs/plan.md',
      bucket: 'demo-project.appspot.com',
      generation: '101',
      metageneration: '1',
      timeCreated: '2026-11-21T14:00:00.000Z',
      updated: '2026-11-21T14:00:00.000Z',
      size: 10,
      customMetadata: { stage: 'draft', owner: 'ada' },
    };
    const v1Patched = {
      ...v1,
      metageneration: '2',
      updated: '2026-11-21T14:05:00.000Z',
      customMetadata: { stage: 'final' },
    };
    const v2 = {
      fullPath: 'docs/plan.md',
      bucket: 'demo-project.appspot.com',
      generation: '102',
      metageneration: '1',
      timeCreated: '2026-11-21T14:10:00.000Z',
      updated: '2026-11-21T14:10:00.000Z',
      size: 24,
    };

    const tCreate = Date.parse('2026-11-21T14:00:00.000Z');
    const tPatch = Date.parse('2026-11-21T14:05:00.000Z');
    const tOverwrite = Date.parse('2026-11-21T14:10:00.000Z');
    const tDelete = Date.parse('2026-11-21T14:15:00.000Z');

    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'docs/plan.md',
      at: tCreate,
      after: v1,
    });
    delivery.emit({
      op: 'metadata_update',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'docs/plan.md',
      at: tPatch,
      before: v1,
      after: v1Patched,
    });
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'docs/plan.md',
      at: tOverwrite,
      before: { ...v1Patched, timeDeleted: 'should-be-stripped' },
      after: v2,
    });
    delivery.emit({
      op: 'object_delete',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'docs/plan.md',
      at: tDelete,
      before: v2,
    });

    await host.idle();

    expect(observed).toEqual([
      {
        label: 'finalized',
        type: 'google.cloud.storage.object.v1.finalized',
        time: '2026-11-21T14:00:00.000Z',
        name: 'docs/plan.md',
        generation: '101',
        metageneration: '1',
        size: '10',
        updated: '2026-11-21T14:00:00.000Z',
        hasTimeDeleted: false,
        timeDeleted: null,
        metadata: { stage: 'draft', owner: 'ada' },
      },
      {
        label: 'metadata',
        type: 'google.cloud.storage.object.v1.metadataUpdated',
        time: '2026-11-21T14:05:00.000Z',
        name: 'docs/plan.md',
        generation: '101',
        metageneration: '2',
        size: '10',
        updated: '2026-11-21T14:05:00.000Z',
        hasTimeDeleted: false,
        timeDeleted: null,
        metadata: { stage: 'final' },
      },
      {
        label: 'archived',
        type: 'google.cloud.storage.object.v1.archived',
        time: '2026-11-21T14:10:00.000Z',
        name: 'docs/plan.md',
        generation: '101',
        metageneration: '2',
        size: '10',
        updated: '2026-11-21T14:05:00.000Z',
        hasTimeDeleted: false,
        timeDeleted: null,
        metadata: { stage: 'final' },
      },
      {
        label: 'finalized',
        type: 'google.cloud.storage.object.v1.finalized',
        time: '2026-11-21T14:10:00.000Z',
        name: 'docs/plan.md',
        generation: '102',
        metageneration: '1',
        size: '24',
        updated: '2026-11-21T14:10:00.000Z',
        hasTimeDeleted: false,
        timeDeleted: null,
        metadata: null,
      },
      {
        label: 'deleted',
        type: 'google.cloud.storage.object.v1.deleted',
        time: '2026-11-21T14:15:00.000Z',
        name: 'docs/plan.md',
        generation: '102',
        metageneration: '1',
        size: '24',
        updated: '2026-11-21T14:10:00.000Z',
        hasTimeDeleted: true,
        timeDeleted: '2026-11-21T14:15:00.000Z',
        metadata: null,
      },
    ]);

    host.close();
  });

  test('suppresses rollback mutations and cancels queued pre-rollback deliveries in tail', async () => {
    const {
      onObjectFinalized,
      onObjectArchived,
      onObjectDeleted,
    } = storageFunctions;

    const seen: string[] = [];
    const { promise: holdFirst, resolve: releaseFirst } = Promise.withResolvers<void>();
    const delivery = new InMemoryStorageTriggerDelivery({
      defaultBucket: 'demo-project.appspot.com',
    });

    const host = startStorageTriggerExecution({
      exported: {
        onFinalized: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, async (event) => {
          seen.push(`finalized:${event.data.name}#${event.data.generation}`);
          if (event.data.name === 'items/blocker.txt') {
            await holdFirst;
          }
        }),
        onArchived: onObjectArchived({ bucket: 'demo-project.appspot.com' }, (event) => {
          seen.push(`archived:${event.data.name}#${event.data.generation}`);
        }),
        onDeleted: onObjectDeleted({ bucket: 'demo-project.appspot.com' }, (event) => {
          seen.push(`deleted:${event.data.name}#${event.data.generation}:${event.data.timeDeleted}`);
        }),
      },
      defaultBucket: 'demo-project.appspot.com',
      delivery,
      eventOptions: (_projected, sequence) => ({
        id: `rb-${sequence}`,
        time: '2026-11-21T16:00:00.000Z',
        location: 'us-central1',
      }),
    });

    await host.ready;

    const snap = (fullPath: string, generation: string) => ({
      fullPath,
      bucket: 'demo-project.appspot.com',
      generation,
      metageneration: '1',
      timeCreated: '2026-11-21T16:00:00.000Z',
      updated: '2026-11-21T16:00:00.000Z',
      size: 5,
    });

    // Hold tail on blocker#1 while a raced overwrite (v1->v2) and its rollback arrive.
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/blocker.txt',
      at: 1000,
      after: snap('items/blocker.txt', '1'),
    });

    // Raced overwrite commit v1(#10) -> v2(#11), immediately rolled back while tail is still held!
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/raced.txt',
      at: 1001,
      before: snap('items/raced.txt', '10'),
      after: snap('items/raced.txt', '11'),
    });
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/raced.txt',
      at: 1002,
      rollback: true,
      before: snap('items/raced.txt', '11'),
      after: snap('items/raced.txt', '10'),
    });

    // Rollback delete of a canceled new upload (#20) must also emit zero deleted triggers.
    delivery.emit({
      op: 'object_delete',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/canceled-new.txt',
      at: 1003,
      rollback: true,
      before: snap('items/canceled-new.txt', '20'),
    });

    // Real delete at at=0 verifies fallback of timeDeleted to baseOptions.time.
    delivery.emit({
      op: 'object_delete',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/real-delete.txt',
      at: 0,
      before: snap('items/real-delete.txt', '30'),
    });

    releaseFirst();
    await host.idle();

    expect(seen).toEqual([
      'finalized:items/blocker.txt#1',
      'deleted:items/real-delete.txt#30:2026-11-21T16:00:00.000Z',
    ]);

    host.close();
  });

  test('routes eventOptions failures to onDeliveryError without poisoning later deliveries or idle()', async () => {
    const { onObjectFinalized } = storageFunctions;
    const delivered: string[] = [];
    const deliveryErrors: Array<{ exportName: string; error: unknown }> = [];
    const clockError = new Error('no browser tab is connected to the sandbox');
    let attempt = 0;

    const delivery = new InMemoryStorageTriggerDelivery({
      defaultBucket: 'demo-project.appspot.com',
    });
    const host = startStorageTriggerExecution({
      exported: {
        onUpload: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, (event) => {
          delivered.push(event.data.name);
        }),
      },
      defaultBucket: 'demo-project.appspot.com',
      delivery,
      eventOptions: async (_projected, sequence) => {
        attempt += 1;
        await Promise.resolve();
        if (attempt === 1) throw clockError;
        return {
          id: `recovered-${sequence}`,
          time: '2026-11-21T16:00:00.000Z',
          location: 'us-central1',
        };
      },
      onDeliveryError(error, trigger) {
        deliveryErrors.push({ exportName: trigger.exportName, error });
      },
    });
    await host.ready;

    const makeSnap = (fullPath: string, generation: string) => ({
      fullPath,
      bucket: 'demo-project.appspot.com',
      generation,
      metageneration: '1',
      timeCreated: '2026-11-21T16:00:00.000Z',
      updated: '2026-11-21T16:00:00.000Z',
      size: 4,
    });

    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/dropped.txt',
      at: 0,
      after: makeSnap('items/dropped.txt', '1'),
    });
    delivery.emit({
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'items/recovered.txt',
      at: 1000,
      after: makeSnap('items/recovered.txt', '2'),
    });
    await host.idle();

    expect(deliveryErrors).toEqual([{ exportName: 'onUpload', error: clockError }]);
    expect(delivered).toEqual(['items/recovered.txt']);
    host.close();
  });
});
