import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { discoverFirestoreTriggers } from '../../src/functions/firestore/discovery.js';
import {
  FIRESTORE_EVENT_DATA_SCHEMA,
  buildFirestoreCloudEvent,
  executeFirestoreTrigger,
} from '../../src/functions/firestore/event.js';
import { FirestoreReferenceValue } from '../../src/functions/firestore/proto-encoder.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
process.env.GCLOUD_PROJECT ??= 'demo-project';
process.env.FIREBASE_CONFIG ??= JSON.stringify({
  projectId: 'demo-project',
  databaseURL: 'https://demo-project-default-rtdb.firebaseio.com',
});
const adminApp = requireFromConformance(
  'firebase-admin/app',
) as typeof import('firebase-admin/app');
const adminFirestore = requireFromConformance(
  'firebase-admin/firestore',
) as typeof import('firebase-admin/firestore');
const functionsV2 = requireFromConformance(
  'firebase-functions/v2',
) as typeof import('firebase-functions/v2');
const firestoreFunctions = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');

let testAdminApp: ReturnType<typeof adminApp.initializeApp> | undefined;
let appSeq = 0;

beforeEach(() => {
  appSeq += 1;
  testAdminApp = adminApp.initializeApp(
    { projectId: 'demo-project' },
    `functions-firestore-event-unit-${appSeq}`,
  );
  functionsV2.app.setEmulatedAdminApp(testAdminApp);
});

afterEach(async () => {
  if (testAdminApp !== undefined) {
    functionsV2.app.setEmulatedAdminApp(undefined as never);
    await adminApp.deleteApp(testAdminApp);
    testAdminApp = undefined;
  }
});

describe('executeFirestoreTrigger', () => {
  test('delivers a production-shaped CloudEvent and decoded QueryDocumentSnapshot with rich types', async () => {
    let observed: Record<string, unknown> | undefined;
    const callable = firestoreFunctions.onDocumentCreated(
      'users/{userId}/orders/{orderId}',
      async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const snap = event.data;
        if (snap === undefined) {
          throw new Error('expected QueryDocumentSnapshot on onDocumentCreated');
        }
        const data = snap.data();
        const createdAt = data.placedAt as InstanceType<typeof adminFirestore.Timestamp>;
        const coords = data.coords as InstanceType<typeof adminFirestore.GeoPoint>;
        const customerRef = data.customer as InstanceType<
          typeof adminFirestore.DocumentReference
        >;
        const attachment = data.attachment as Buffer;

        observed = {
          id: event.id,
          specversion: event.specversion,
          source: event.source,
          subject: event.subject,
          type: event.type,
          time: event.time,
          location: event.location,
          project: event.project,
          database: event.database,
          namespace: event.namespace,
          document: event.document,
          params: event.params,
          hasDatacontenttype: 'datacontenttype' in event,
          hasDataschema: 'dataschema' in event,
          hasAuthType: 'authType' in event,
          hasAuthId: 'authId' in event,
          snapExists: snap.exists,
          snapId: snap.id,
          snapPath: snap.ref.path,
          createSeconds: snap.createTime.seconds,
          createNanos: snap.createTime.nanoseconds,
          updateSeconds: snap.updateTime.seconds,
          updateNanos: snap.updateTime.nanoseconds,
          nestedAmount: snap.get('totals.cents'),
          placedAtMillis: createdAt.toMillis(),
          lat: coords.latitude,
          lng: coords.longitude,
          customerPath: customerRef.path,
          attachmentHex: attachment.toString('hex'),
          tags: data.tags,
          meta: data.meta,
          v1EventType: event.context.eventType,
        };
        return 'order-processed';
      },
    );

    const [trigger] = discoverFirestoreTriggers({ onOrderCreated: callable });
    if (trigger === undefined) {
      throw new Error('expected discovered onOrderCreated trigger');
    }

    const rawEnvelope = buildFirestoreCloudEvent(trigger.eventType, false, {
      id: 'evt-raw',
      time: '2026-07-13T20:00:00.125Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'users/alice/orders/ord-99',
      before: null,
      after: {
        fields: { total: 1 },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
    });
    expect(rawEnvelope.datacontenttype).toBe('application/protobuf');
    expect(rawEnvelope.dataschema).toBe(FIRESTORE_EVENT_DATA_SCHEMA);
    expect(Buffer.isBuffer(rawEnvelope.data)).toBe(true);

    const result = await executeFirestoreTrigger(trigger, {
      id: 'evt-101',
      time: '2026-07-13T20:00:00.125Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'users/alice/orders/ord-99',
      before: null,
      after: {
        fields: {
          placedAt: new adminFirestore.Timestamp(1_720_900_800, 250_000_000),
          coords: new adminFirestore.GeoPoint(40.7128, -74.006),
          customer: new FirestoreReferenceValue('users/alice'),
          attachment: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
          tags: ['priority', 2, true, null],
          totals: { cents: 4999, discount: 0.15 },
          meta: { note: 'leave at door' },
        },
        createTime: { seconds: 1_720_900_800, nanos: 125_000_000 },
        updateTime: { seconds: 1_720_900_800, nanos: 125_000_000 },
      },
    });

    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') {
      expect(result.result).toBe('order-processed');
    }
    expect(observed).toEqual({
      id: 'evt-101',
      specversion: '1.0',
      source: '//firestore.googleapis.com/projects/demo-project/databases/(default)',
      subject: 'documents/users/alice/orders/ord-99',
      type: 'google.cloud.firestore.document.v1.created',
      time: '2026-07-13T20:00:00.125Z',
      location: 'us-central1',
      project: 'demo-project',
      database: '(default)',
      namespace: '(default)',
      document: 'users/alice/orders/ord-99',
      params: { userId: 'alice', orderId: 'ord-99' },
      hasDatacontenttype: false,
      hasDataschema: false,
      hasAuthType: false,
      hasAuthId: false,
      snapExists: true,
      snapId: 'ord-99',
      snapPath: 'users/alice/orders/ord-99',
      createSeconds: 1_720_900_800,
      createNanos: 125_000_000,
      updateSeconds: 1_720_900_800,
      updateNanos: 125_000_000,
      nestedAmount: 4999,
      placedAtMillis: 1_720_900_800_250,
      lat: 40.7128,
      lng: -74.006,
      customerPath: 'users/alice',
      attachmentHex: 'deadbeef',
      tags: ['priority', 2, true, null],
      meta: { note: 'leave at door' },
      v1EventType: 'providers/cloud.firestore/eventTypes/document.create',
    });
  });

  test('captures rejected handler promises cleanly as status rejected', async () => {
    const boom = new Error('EXPECTED_FIRESTORE_HANDLER_FAILURE');
    const callable = firestoreFunctions.onDocumentCreated('users/{uid}', async () => {
      throw boom;
    });
    const [trigger] = discoverFirestoreTriggers({ failingTrigger: callable });
    if (trigger === undefined) {
      throw new Error('expected discovered failingTrigger');
    }

    const result = await executeFirestoreTrigger(trigger, {
      id: 'evt-err',
      time: '2026-07-13T20:00:00.000Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'users/bob',
      before: null,
      after: {
        fields: { name: 'Bob' },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
    });

    expect(result).toMatchObject({ status: 'rejected', error: boom });
  });
});
