import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { InMemoryRtdbTriggerDelivery } from '../../src/functions-rtdb/in-memory-delivery.js';
import { startOnValueCreatedExecution } from '../../src/functions-rtdb/execution.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');

describe('startOnValueCreatedExecution', () => {
  test('rejects readiness when the snapshot source fails before its baseline', async () => {
    const sourceError = new Error('snapshot relay unavailable');
    const created = databaseFunctions.onValueCreated('/items/{itemId}', () => undefined);
    const host = startOnValueCreatedExecution({
      exported: { created },
      delivery: {
        subscribe(_path, _listener, onError) {
          onError?.(sourceError);
          return () => undefined;
        },
      },
      eventOptions: () => {
        throw new Error('no event should be built before readiness');
      },
    });

    await expect(
      Promise.race([
        host.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ready remained pending')), 20),
        ),
      ]),
    ).rejects.toBe(sourceError);
    host.close();
  });

  test('treats the first snapshot as a baseline and delivers only a later absent-to-present value', async () => {
    const { onValueCreated } = databaseFunctions;
    const values: unknown[] = [];
    const makeUppercase = onValueCreated(
      '/messages/id/original',
      (event) => {
        values.push(event.data.val());
      },
    );
    const delivery = new InMemoryRtdbTriggerDelivery();
    delivery.seed('/messages/id/original', 'already here');
    const host = startOnValueCreatedExecution({
      exported: { makeUppercase },
      delivery,
      eventOptions: (_projection, sequence) => ({
        id: `delivery-${sequence}`,
        time: '2026-07-13T20:00:00.000Z',
        projectId: 'demo-project',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      }),
    });

    expect(host.ready).toBeInstanceOf(Promise);
    await host.ready;
    expect(values).toEqual([]);

    delivery.emit('/messages/id/original', 'updated');
    delivery.emit('/messages/id/original', null);
    delivery.emit('/messages/id/original', 'created again');
    await host.idle();

    expect(values).toEqual(['created again']);
    host.close();
  });

  test('serializes handler execution across successive snapshot deliveries', async () => {
    const { onValueCreated } = databaseFunctions;
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const created = onValueCreated('/items/{itemId}', async (event) => {
      started.push(event.params.itemId);
      if (event.params.itemId === 'one') await firstBlocked;
    });
    const delivery = new InMemoryRtdbTriggerDelivery();
    delivery.seed('/items', null);
    const host = startOnValueCreatedExecution({
      exported: { created },
      delivery,
      eventOptions: (_projection, sequence) => ({
        id: `serial-${sequence}`,
        time: '2026-07-13T20:00:00.000Z',
        projectId: 'demo-project',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      }),
    });
    await host.ready;

    delivery.emit('/items', { one: 1 });
    delivery.emit('/items', { one: 1, two: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['one']);

    releaseFirst();
    await host.idle();
    expect(started).toEqual(['one', 'two']);
    host.close();
  });
});
