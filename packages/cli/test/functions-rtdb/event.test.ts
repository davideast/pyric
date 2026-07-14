import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { discoverOnValueCreated } from '../../src/functions-rtdb/discovery.js';
import { executeOnValueCreated } from '../../src/functions-rtdb/event.js';

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
    'functions-rtdb-event-test',
  );
  functionsV2.app.setEmulatedAdminApp(testAdminApp);
});

afterAll(async () => {
  await adminApp.deleteApp(testAdminApp);
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
          source: event.source,
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
      source: '//firebasedatabase.googleapis.com/projects/_/locations/us-central1/instances/demo-project-default-rtdb',
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
