import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  CREATED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  UPDATED_EVENT_TYPE,
  WRITTEN_EVENT_TYPE,
  discoverRtdbValueTriggers,
  inspectRtdbValueTriggers,
  rtdbValueTriggerFamily,
} from '../../src/functions/rtdb/discovery.js';
import {
  computeRtdbDelta,
  executeRtdbValueTrigger,
} from '../../src/functions/rtdb/event.js';
import { startRtdbValueExecution } from '../../src/functions/rtdb/execution.js';
import { InMemoryRtdbTriggerDelivery } from '../../src/functions/rtdb/in-memory-delivery.js';
import {
  projectRtdbValueTransitions,
  rtdbValuesEqual,
} from '../../src/functions/rtdb/projection.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

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
const firestoreFunctions = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');
const functionsV1 = requireFromConformance(
  'firebase-functions/v1',
) as typeof import('firebase-functions/v1');

let testAdminApp: ReturnType<typeof adminApp.initializeApp> | undefined;
let appSeq = 0;

beforeEach(() => {
  appSeq += 1;
  testAdminApp = adminApp.initializeApp(
    { projectId: 'demo-project' },
    `functions-rtdb-v2-unit-test-${appSeq}`,
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

describe('discoverRtdbValueTriggers and rtdbValueTriggerFamily', () => {
  test('discovers all four v2 RTDB trigger types and refuses omitted, glob, v1, and Firestore triggers', () => {
    const { onValueCreated, onValueUpdated, onValueDeleted, onValueWritten } = databaseFunctions;
    const created = onValueCreated('/items/{id}', () => undefined);
    const updated = onValueUpdated({ ref: '/items/{id}', instance: 'shard-a', region: 'europe-west1' }, () => undefined);
    const deleted = onValueDeleted('/items/{id}', () => undefined);
    const written = onValueWritten('/items/{id}', () => undefined);
    const omittedUpdate = onValueUpdated({ ref: '/items/{id}', omit: true }, () => undefined);
    const invalidRefDelete = onValueDeleted('/items/{id=**}', () => undefined);
    const v1Write = functionsV1.database.ref('/legacy/{id}').onWrite(() => null);
    const firestoreCreate = firestoreFunctions.onDocumentCreated('docs/{id}', () => undefined);

    const exported = {
      created,
      updated,
      deleted,
      written,
      omittedUpdate,
      invalidRefDelete,
      v1Write,
      firestoreCreate,
    };

    const inspected = inspectRtdbValueTriggers(exported);
    expect(
      inspected.triggers.map((item) => ({
        exportName: item.exportName,
        eventType: item.eventType,
        reference: item.reference,
        instance: item.instance,
        location: item.location,
      })),
    ).toEqual([
      {
        exportName: 'created',
        eventType: CREATED_EVENT_TYPE,
        reference: 'items/{id}',
        instance: '*',
        location: undefined,
      },
      {
        exportName: 'updated',
        eventType: UPDATED_EVENT_TYPE,
        reference: 'items/{id}',
        instance: 'shard-a',
        location: 'europe-west1',
      },
      {
        exportName: 'deleted',
        eventType: DELETED_EVENT_TYPE,
        reference: 'items/{id}',
        instance: '*',
        location: undefined,
      },
      {
        exportName: 'written',
        eventType: WRITTEN_EVENT_TYPE,
        reference: 'items/{id}',
        instance: '*',
        location: undefined,
      },
    ]);

    expect(findUnsupportedTriggers(exported, [rtdbValueTriggerFamily])).toEqual([
      {
        exportName: 'omittedUpdate',
        eventType: `${UPDATED_EVENT_TYPE} (omitted from emulation)`,
      },
      {
        exportName: 'invalidRefDelete',
        eventType: `${DELETED_EVENT_TYPE} (unsupported ref pattern: items/{id=**})`,
      },
      {
        exportName: 'v1Write',
        eventType: 'providers/google.firebase.database/eventTypes/ref.write',
      },
      {
        exportName: 'firestoreCreate',
        eventType: 'google.cloud.firestore.document.v1.created',
      },
    ]);
  });
});

describe('projectRtdbValueTransitions and rtdbValuesEqual', () => {
  test('treats pruned RTDB equivalents and dense numeric-keyed objects as equal', () => {
    expect(rtdbValuesEqual({ a: 1, empty: {}, gone: null }, { a: 1 })).toBe(true);
    expect(rtdbValuesEqual([10, 20], { '0': 10, '1': 20 })).toBe(true);
    expect(rtdbValuesEqual([10, null], [10])).toBe(true);
    expect(rtdbValuesEqual(1, '1')).toBe(false);
    expect(rtdbValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  test('projects updated, deleted, and written transitions across ancestor wildcard commits', () => {
    const commit = {
      path: '/rooms',
      before: {
        unchanged: { topic: 'general' },
        edited: { topic: 'old', legacyFlag: true },
        removed: { topic: 'archive' },
      },
      after: {
        unchanged: { topic: 'general', ignoredEmpty: {} },
        edited: { topic: 'new' },
        added: { topic: 'fresh' },
      },
    };

    expect(projectRtdbValueTransitions(UPDATED_EVENT_TYPE, '/rooms/{roomId}', commit)).toEqual([
      {
        kind: 'updated',
        ref: 'rooms/edited',
        params: { roomId: 'edited' },
        before: { topic: 'old', legacyFlag: true },
        after: { topic: 'new' },
      },
    ]);

    expect(projectRtdbValueTransitions(DELETED_EVENT_TYPE, '/rooms/{roomId}', commit)).toEqual([
      {
        kind: 'deleted',
        ref: 'rooms/removed',
        params: { roomId: 'removed' },
        before: { topic: 'archive' },
        after: null,
      },
    ]);

    expect(projectRtdbValueTransitions(WRITTEN_EVENT_TYPE, '/rooms/{roomId}', commit)).toEqual([
      {
        kind: 'created',
        ref: 'rooms/added',
        params: { roomId: 'added' },
        before: null,
        after: { topic: 'fresh' },
      },
      {
        kind: 'updated',
        ref: 'rooms/edited',
        params: { roomId: 'edited' },
        before: { topic: 'old', legacyFlag: true },
        after: { topic: 'new' },
      },
      {
        kind: 'deleted',
        ref: 'rooms/removed',
        params: { roomId: 'removed' },
        before: { topic: 'archive' },
        after: null,
      },
    ]);
  });

  test('projects descendant wildcard deletes when an entire ancestor subtree is removed', () => {
    const commit = {
      path: '/orgs',
      before: {
        acme: { members: { u1: { role: 'owner' }, u2: { role: 'editor' } } },
      },
      after: null,
    };

    expect(
      projectRtdbValueTransitions(DELETED_EVENT_TYPE, '/orgs/{orgId}/members/{uid}', commit),
    ).toEqual([
      {
        kind: 'deleted',
        ref: 'orgs/acme/members/u1',
        params: { orgId: 'acme', uid: 'u1' },
        before: { role: 'owner' },
        after: null,
      },
      {
        kind: 'deleted',
        ref: 'orgs/acme/members/u2',
        params: { orgId: 'acme', uid: 'u2' },
        before: { role: 'editor' },
        after: null,
      },
    ]);
  });
});

describe('computeRtdbDelta and executeRtdbValueTrigger with real firebase-functions wrappers', () => {
  test('delivers Change<DataSnapshot> for onValueUpdated including removed child keys and shortened arrays', async () => {
    const { onValueUpdated } = databaseFunctions;
    let observedBefore: unknown;
    let observedAfter: unknown;
    let beforeExisted = false;
    let afterExisted = false;

    const [trigger] = discoverRtdbValueTriggers({
      itemUpdated: onValueUpdated('/carts/{cartId}', (event) => {
        beforeExisted = event.data.before.exists();
        afterExisted = event.data.after.exists();
        observedBefore = event.data.before.val();
        observedAfter = event.data.after.val();
      }),
    });
    if (trigger === undefined) throw new Error('expected discovered trigger');

    const beforeValue = {
      coupon: 'SAVE10',
      keep: 'same',
      skus: ['sku-1', 'sku-2', 'sku-3'],
    };
    const afterValue = {
      keep: 'same',
      skus: ['sku-1'],
      total: 19,
    };

    expect(computeRtdbDelta(beforeValue, afterValue)).toEqual({
      coupon: null,
      skus: { '1': null, '2': null },
      total: 19,
    });

    const outcome = await executeRtdbValueTrigger(
      trigger,
      {
        kind: 'updated',
        ref: 'carts/c1',
        params: { cartId: 'c1' },
        before: beforeValue,
        after: afterValue,
      },
      {
        id: 'upd-1',
        time: '2026-07-13T20:00:00.000Z',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      },
    );

    expect(outcome.status).toBe('fulfilled');
    expect(beforeExisted).toBe(true);
    expect(afterExisted).toBe(true);
    expect(observedBefore).toEqual(beforeValue);
    expect(observedAfter).toEqual(afterValue);
  });

  test('delivers removed DataSnapshot for onValueDeleted and full lifecycle Change<DataSnapshot> for onValueWritten', async () => {
    const { onValueDeleted, onValueWritten } = databaseFunctions;
    let deletedSnapshot: { exists: boolean; val: unknown; type: string; params: Record<string, string> } | undefined;
    const writtenSnapshots: Array<{
      beforeExists: boolean;
      afterExists: boolean;
      beforeVal: unknown;
      afterVal: unknown;
    }> = [];

    const triggers = discoverRtdbValueTriggers({
      itemDeleted: onValueDeleted('/notes/{noteId}', (event) => {
        deletedSnapshot = {
          exists: event.data.exists(),
          val: event.data.val(),
          type: event.type,
          params: event.params,
        };
      }),
      itemWritten: onValueWritten('/notes/{noteId}', (event) => {
        writtenSnapshots.push({
          beforeExists: event.data.before.exists(),
          afterExists: event.data.after.exists(),
          beforeVal: event.data.before.val(),
          afterVal: event.data.after.val(),
        });
      }),
    });

    const delivery = new InMemoryRtdbTriggerDelivery();
    delivery.seed('/notes', { preseeded: 'ignored' });
    const host = startRtdbValueExecution({
      exported: {
        itemDeleted: triggers[0]?.callable,
        itemWritten: triggers[1]?.callable,
      },
      delivery,
      eventOptions: (_projection, sequence) => ({
        id: `lifecycle-${sequence}`,
        time: '2026-07-13T20:00:00.000Z',
        instance: 'demo-project-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
      }),
    });
    await host.ready;
    expect(writtenSnapshots).toEqual([]);

    delivery.emit('/notes', { preseeded: 'ignored', n1: { text: 'v1' } });
    delivery.emit('/notes', { preseeded: 'ignored', n1: { text: 'v1' } });
    delivery.emit('/notes', { preseeded: 'ignored', n1: { text: 'v2' } });
    delivery.emit('/notes', { preseeded: 'ignored' });
    await host.idle();

    expect(deletedSnapshot).toEqual({
      exists: true,
      val: { text: 'v2' },
      type: DELETED_EVENT_TYPE,
      params: { noteId: 'n1' },
    });
    expect(writtenSnapshots).toEqual([
      { beforeExists: false, afterExists: true, beforeVal: null, afterVal: { text: 'v1' } },
      {
        beforeExists: true,
        afterExists: true,
        beforeVal: { text: 'v1' },
        afterVal: { text: 'v2' },
      },
      { beforeExists: true, afterExists: false, beforeVal: { text: 'v2' }, afterVal: null },
    ]);
    host.close();
  });
});
