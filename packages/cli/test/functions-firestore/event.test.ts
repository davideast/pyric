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

  test('delivers Change<QueryDocumentSnapshot> to onDocumentUpdated and prior snapshot to onDocumentDeleted', async () => {
    let updatedSummary: Record<string, unknown> | undefined;
    const onUpdated = firestoreFunctions.onDocumentUpdated(
      'tickets/{ticketId}',
      (event) => {
        const change = event.data;
        if (change === undefined) {
          throw new Error('expected Change on onDocumentUpdated');
        }
        updatedSummary = {
          type: event.type,
          ticketId: event.params.ticketId,
          beforeExists: change.before.exists,
          afterExists: change.after.exists,
          beforeData: change.before.data(),
          afterData: change.after.data(),
          sameCreateTime: change.before.createTime.isEqual(change.after.createTime),
          advancedUpdateTime:
            change.after.updateTime.toMillis() > change.before.updateTime.toMillis(),
          v1EventType: event.context.eventType,
        };
      },
    );

    let deletedSummary: Record<string, unknown> | undefined;
    const onDeleted = firestoreFunctions.onDocumentDeleted(
      'tickets/{ticketId}',
      (event) => {
        const snap = event.data;
        if (snap === undefined) {
          throw new Error('expected QueryDocumentSnapshot on onDocumentDeleted');
        }
        deletedSummary = {
          type: event.type,
          ticketId: event.params.ticketId,
          exists: snap.exists,
          path: snap.ref.path,
          data: snap.data(),
          v1EventType: event.context.eventType,
        };
      },
    );

    const discovered = discoverFirestoreTriggers({ onUpdated, onDeleted });
    const updateTrigger = discovered[0];
    const deleteTrigger = discovered[1];
    if (updateTrigger === undefined || deleteTrigger === undefined) {
      throw new Error('expected updated and deleted triggers');
    }

    const updateResult = await executeFirestoreTrigger(updateTrigger, {
      id: 'evt-upd-1',
      time: '2026-07-13T20:01:00.000Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'tickets/t-42',
      before: {
        fields: { status: 'open', priority: 1 },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
      after: {
        fields: { status: 'closed', priority: 1 },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_860, nanos: 0 },
      },
      updateMask: ['status'],
    });
    expect(updateResult.status).toBe('fulfilled');
    expect(updatedSummary).toEqual({
      type: 'google.cloud.firestore.document.v1.updated',
      ticketId: 't-42',
      beforeExists: true,
      afterExists: true,
      beforeData: { status: 'open', priority: 1 },
      afterData: { status: 'closed', priority: 1 },
      sameCreateTime: true,
      advancedUpdateTime: true,
      v1EventType: 'providers/cloud.firestore/eventTypes/document.update',
    });

    const deleteResult = await executeFirestoreTrigger(deleteTrigger, {
      id: 'evt-del-1',
      time: '2026-07-13T20:02:00.000Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'tickets/t-42',
      before: {
        fields: { status: 'closed', priority: 1 },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_860, nanos: 0 },
      },
      after: null,
    });
    expect(deleteResult.status).toBe('fulfilled');
    expect(deletedSummary).toEqual({
      type: 'google.cloud.firestore.document.v1.deleted',
      ticketId: 't-42',
      exists: true,
      path: 'tickets/t-42',
      data: { status: 'closed', priority: 1 },
      v1EventType: 'providers/cloud.firestore/eventTypes/document.delete',
    });
  });

  test('delivers Change<DocumentSnapshot> to onDocumentWritten across create, update, and delete', async () => {
    const states: Array<Record<string, unknown>> = [];
    const onWritten = firestoreFunctions.onDocumentWritten(
      'notes/{noteId}',
      (event) => {
        const change = event.data;
        if (change === undefined) {
          throw new Error('expected Change on onDocumentWritten');
        }
        states.push({
          noteId: event.params.noteId,
          beforeExists: change.before.exists,
          afterExists: change.after.exists,
          beforePath: change.before.ref.path,
          afterPath: change.after.ref.path,
          beforeData: change.before.data(),
          afterData: change.after.data(),
          beforeCreateUndefined: change.before.createTime === undefined,
          afterCreateUndefined: change.after.createTime === undefined,
          v1EventType: event.context.eventType,
        });
      },
    );

    const [trigger] = discoverFirestoreTriggers({ onWritten });
    if (trigger === undefined) {
      throw new Error('expected discovered onWritten trigger');
    }

    const baseEnvelope = {
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'notes/n-1',
    };

    await executeFirestoreTrigger(trigger, {
      ...baseEnvelope,
      id: 'w-1',
      time: '2026-07-13T20:00:00.000Z',
      before: null,
      after: {
        fields: { body: 'v1' },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
    });
    await executeFirestoreTrigger(trigger, {
      ...baseEnvelope,
      id: 'w-2',
      time: '2026-07-13T20:00:10.000Z',
      before: {
        fields: { body: 'v1' },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
      after: {
        fields: { body: 'v2' },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_810, nanos: 0 },
      },
      updateMask: ['body'],
    });
    await executeFirestoreTrigger(trigger, {
      ...baseEnvelope,
      id: 'w-3',
      time: '2026-07-13T20:00:20.000Z',
      before: {
        fields: { body: 'v2' },
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_810, nanos: 0 },
      },
      after: null,
    });

    expect(states).toEqual([
      {
        noteId: 'n-1',
        beforeExists: false,
        afterExists: true,
        beforePath: 'notes/n-1',
        afterPath: 'notes/n-1',
        beforeData: undefined,
        afterData: { body: 'v1' },
        beforeCreateUndefined: true,
        afterCreateUndefined: false,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
      },
      {
        noteId: 'n-1',
        beforeExists: true,
        afterExists: true,
        beforePath: 'notes/n-1',
        afterPath: 'notes/n-1',
        beforeData: { body: 'v1' },
        afterData: { body: 'v2' },
        beforeCreateUndefined: false,
        afterCreateUndefined: false,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
      },
      {
        noteId: 'n-1',
        beforeExists: true,
        afterExists: false,
        beforePath: 'notes/n-1',
        afterPath: 'notes/n-1',
        beforeData: { body: 'v2' },
        afterData: undefined,
        beforeCreateUndefined: false,
        afterCreateUndefined: true,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
      },
    ]);
  });
});
