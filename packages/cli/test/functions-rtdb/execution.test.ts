import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  discoverOnValueCreated,
  executeOnValueCreated,
  InMemoryRtdbTriggerDelivery,
  projectValueCreates,
  startOnValueCreatedExecution,
  type RtdbSnapshotCommit,
} from '../../src/functions-rtdb/index.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
process.env.GCLOUD_PROJECT ??= 'demo-project';
process.env.FIREBASE_CONFIG ??= JSON.stringify({
  projectId: 'demo-project',
  databaseURL: 'https://demo-project-default-rtdb.firebaseio.com',
});

const adminApp = requireFromConformance('firebase-admin/app') as typeof import('firebase-admin/app');
const functionsV2 = requireFromConformance('firebase-functions/v2') as typeof import('firebase-functions/v2');
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
let testAdminApp: ReturnType<typeof adminApp.initializeApp>;

beforeAll(() => {
  testAdminApp = adminApp.initializeApp(
    { projectId: 'demo-project' },
    'functions-rtdb-execution-test',
  );
  functionsV2.app.setEmulatedAdminApp(testAdminApp);
});

afterAll(async () => {
  await adminApp.deleteApp(testAdminApp);
});

describe('projectValueCreates', () => {
  test('projects one exact absent-to-present transition at the matched ref', () => {
    const commit: RtdbSnapshotCommit = {
      path: '/messages/id/original',
      before: null,
      after: 'hello',
    };

    expect(projectValueCreates('/messages/id/original', commit)).toEqual([
      {
        ref: 'messages/id/original',
        params: {},
        value: 'hello',
      },
    ]);
  });

  test('expands named single-segment wildcards and captures their params', () => {
    const commit: RtdbSnapshotCommit = {
      path: '/cases/single/items',
      before: null,
      after: {
        itemA: { marker: 'single' },
      },
    };

    expect(projectValueCreates('/cases/{caseId}/items/{itemId}', commit)).toEqual([
      {
        ref: 'cases/single/items/itemA',
        params: { caseId: 'single', itemId: 'itemA' },
        value: { marker: 'single' },
      },
    ]);
  });

  test('projects every newly present matched descendant from ancestor and multi-path snapshots', () => {
    expect(
      projectValueCreates('/cases/{caseId}/items/{itemId}', {
        path: '/cases',
        before: {
          multi: { items: { existing: { marker: 'keep' } } },
        },
        after: {
          multi: {
            items: {
              existing: { marker: 'updated but not created' },
              delta: { marker: 'multi-a' },
              gamma: { marker: 'multi-b' },
            },
          },
        },
      }),
    ).toEqual([
      {
        ref: 'cases/multi/items/delta',
        params: { caseId: 'multi', itemId: 'delta' },
        value: { marker: 'multi-a' },
      },
      {
        ref: 'cases/multi/items/gamma',
        params: { caseId: 'multi', itemId: 'gamma' },
        value: { marker: 'multi-b' },
      },
    ]);
  });

  test('fans out an ancestor create and projects each snapshot to its matched descendant', () => {
    expect(
      projectValueCreates('/batches/{batchId}/items/{itemId}', {
        path: '/batches',
        before: null,
        after: {
          fanout: {
            items: {
              alpha: { marker: 'fanout-a' },
              beta: { marker: 'fanout-b' },
            },
            sibling: { excluded: true },
          },
        },
      }),
    ).toEqual([
      {
        ref: 'batches/fanout/items/alpha',
        params: { batchId: 'fanout', itemId: 'alpha' },
        value: { marker: 'fanout-a' },
      },
      {
        ref: 'batches/fanout/items/beta',
        params: { batchId: 'fanout', itemId: 'beta' },
        value: { marker: 'fanout-b' },
      },
    ]);
  });
});

describe('discoverOnValueCreated', () => {
  test('recognizes real v2 RTDB create callables by endpoint metadata', () => {
    const { onValueCreated, onValueUpdated } = databaseFunctions;
    const created = onValueCreated('/messages/{pushId}/original', () => undefined);
    const updated = onValueUpdated('/messages/{pushId}/original', () => undefined);

    expect(discoverOnValueCreated({ created, updated, helper: () => undefined })).toEqual([
      {
        exportName: 'created',
        reference: 'messages/{pushId}/original',
        instance: '*',
        callable: created,
      },
    ]);
  });

  test('keeps a trigger-specific instance and region for the raw event', () => {
    const { onValueCreated } = databaseFunctions;
    const regional = onValueCreated({
      ref: '/messages/{id}',
      instance: 'regional-rtdb',
      region: 'europe-west1',
    }, () => undefined);

    expect(discoverOnValueCreated({ regional })).toEqual([{
      exportName: 'regional',
      reference: 'messages/{id}',
      instance: 'regional-rtdb',
      location: 'europe-west1',
      callable: regional,
    }]);
  });
});

describe('executeOnValueCreated', () => {
  test('awaits the real SDK callable and supplies a production-shaped create event', async () => {
    const { onValueCreated } = databaseFunctions;

    let received: Record<string, unknown> | undefined;
    let finished = false;
    const callable = onValueCreated(
      '/messages/{pushId}/original',
      async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        received = {
          id: event.id,
          type: event.type,
          time: event.time,
          instance: event.instance,
          location: event.location,
          ref: event.ref,
          subject: event.subject,
          params: event.params,
          authType: event.authType,
          authId: event.authId,
          value: event.data.val(),
        };
        finished = true;
      },
    );
    const [trigger] = discoverOnValueCreated({ makeUppercase: callable });

    const result = await executeOnValueCreated(
      trigger,
      {
        ref: 'messages/id/original',
        params: { pushId: 'id' },
        value: 'hello',
      },
      {
        id: 'delivery-1',
        time: '2026-07-13T20:00:00.000Z',
        projectId: 'demo-project',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      },
    );

    expect(finished).toBe(true);
    expect(result.status).toBe('fulfilled');
    expect(received).toEqual({
      id: 'delivery-1',
      type: 'google.firebase.database.ref.v1.created',
      time: '2026-07-13T20:00:00.000Z',
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      ref: 'messages/id/original',
      subject: 'refs/messages/id/original',
      params: { pushId: 'id' },
      authType: 'unknown',
      authId: null,
      value: 'hello',
    });
  });

  test('returns a rejected execution report for a thrown handler error', async () => {
    const { onValueCreated } = databaseFunctions;
    const marker = new Error('PYRIC_EXPECTED_ONVALUECREATED_FAILURE');
    const [trigger] = discoverOnValueCreated({
      failed: onValueCreated('/failures/{id}', async () => {
        throw marker;
      }),
    });

    const result = await executeOnValueCreated(
      trigger,
      { ref: 'failures/one', params: { id: 'one' }, value: true },
      {
        id: 'failed-delivery',
        time: '2026-07-13T20:00:00.000Z',
        projectId: 'demo-project',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      },
    );

    expect(result).toMatchObject({ status: 'rejected', error: marker });
  });

  test('presents RTDB object children in production key order', async () => {
    const { onValueCreated } = databaseFunctions;
    const childKeys: Array<string | null> = [];
    const [trigger] = discoverOnValueCreated({
      ordered: onValueCreated('/ordered', (event) => {
        event.data.forEach((child) => {
          childKeys.push(child.key);
        });
      }),
    });

    await executeOnValueCreated(
      trigger,
      {
        ref: 'ordered',
        params: {},
        value: { hello: 1, count: 2, nested: 3, items: 4 },
      },
      {
        id: 'ordered-1',
        time: '2026-07-13T20:00:00.000Z',
        projectId: 'demo-project',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      },
    );

    expect(childKeys).toEqual(['count', 'hello', 'items', 'nested']);
  });
});

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
