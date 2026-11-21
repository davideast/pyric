import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startFirestoreTriggerExecution } from '../../src/functions/firestore/execution.js';
import { InMemoryFirestoreTriggerDelivery } from '../../src/functions/firestore/in-memory-delivery.js';

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
    `functions-firestore-execution-unit-${appSeq}`,
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

describe('startFirestoreTriggerExecution', () => {
  test('rejects readiness when delivery errors before reporting ready', async () => {
    const relayErr = new Error('firestore write stream failed');
    const created = firestoreFunctions.onDocumentCreated('users/{uid}', () => undefined);
    const errors: unknown[] = [];

    const host = startFirestoreTriggerExecution({
      exported: { created },
      delivery: {
        subscribe(_db, callbacks) {
          callbacks.onError?.(relayErr);
          return () => undefined;
        },
      },
      envelopeOptions: () => {
        throw new Error('should not build envelope before ready');
      },
      onDeliveryError(err) {
        errors.push(err);
      },
    });

    await expect(host.ready).rejects.toBe(relayErr);
    expect(errors).toEqual([relayErr]);
    host.close();
  });

  test('fires only on absent-to-present creates, scopes by database, and serializes async handlers', async () => {
    const callOrder: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const defaultTrigger = firestoreFunctions.onDocumentCreated(
      'users/{userId}/orders/{orderId}',
      async (event) => {
        callOrder.push(`start:${event.params.userId}:${event.params.orderId}`);
        if (event.params.orderId === 'ord-1') {
          await gate;
        }
        callOrder.push(`end:${event.params.userId}:${event.params.orderId}`);
      },
    );
    const analyticsTrigger = firestoreFunctions.onDocumentCreated(
      { document: 'events/{eventId}', database: 'analytics', region: 'europe-west1' },
      (event) => {
        callOrder.push(`analytics:${event.params.eventId}:${event.location}`);
      },
    );

    const delivery = new InMemoryFirestoreTriggerDelivery();
    delivery.seed('users/alice/orders/preexisting', { total: 10 });

    const host = startFirestoreTriggerExecution({
      exported: { defaultTrigger, analyticsTrigger },
      delivery,
      envelopeOptions: (matched, sequence, trigger) => ({
        id: `seq-${sequence}`,
        time: matched.mutation.time,
        projectId: 'demo-project',
        location: trigger.location ?? 'us-central1',
      }),
    });

    expect(host.triggerCount).toBe(2);
    await host.ready;
    expect(callOrder).toEqual([]);

    // Update to pre-existing document must NOT fire onDocumentCreated
    delivery.emitCreate({
      document: 'users/alice/orders/preexisting',
      fields: { total: 20 },
    });

    // Two creates on (default) + one create on analytics
    delivery.emitCreate({
      document: 'users/alice/orders/ord-1',
      fields: { total: 100 },
    });
    delivery.emitCreate({
      document: 'users/bob/orders/ord-2',
      fields: { total: 200 },
    });
    delivery.emitCreate({
      database: 'analytics',
      document: 'events/ev-7',
      fields: { kind: 'purchase' },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(callOrder).toEqual(['start:alice:ord-1']);

    releaseFirst();
    await host.idle();

    expect(callOrder).toEqual([
      'start:alice:ord-1',
      'end:alice:ord-1',
      'start:bob:ord-2',
      'end:bob:ord-2',
      'analytics:ev-7:europe-west1',
    ]);

    host.close();
    delivery.emitCreate({
      document: 'users/carol/orders/ord-3',
      fields: { total: 300 },
    });
    await host.idle();
    expect(callOrder.length).toBe(5);
  });

  test('routes create, update, and delete across all 4 lifecycle triggers and suppresses no-op updates', async () => {
    const log: string[] = [];
    const onCreated = firestoreFunctions.onDocumentCreated('items/{id}', (ev) => {
      log.push(`created:${ev.params.id}:${JSON.stringify(ev.data?.data())}`);
    });
    const onUpdated = firestoreFunctions.onDocumentUpdated('items/{id}', (ev) => {
      log.push(
        `updated:${ev.params.id}:${JSON.stringify(ev.data?.before.data())}->${JSON.stringify(ev.data?.after.data())}`,
      );
    });
    const onDeleted = firestoreFunctions.onDocumentDeleted('items/{id}', (ev) => {
      log.push(`deleted:${ev.params.id}:${JSON.stringify(ev.data?.data())}`);
    });
    const onWritten = firestoreFunctions.onDocumentWritten('items/{id}', (ev) => {
      log.push(
        `written:${ev.params.id}:${String(ev.data?.before.exists)}->${String(ev.data?.after.exists)}`,
      );
    });

    const delivery = new InMemoryFirestoreTriggerDelivery();
    const host = startFirestoreTriggerExecution({
      exported: { onCreated, onUpdated, onDeleted, onWritten },
      delivery,
      envelopeOptions: (matched, sequence) => ({
        id: `lifecycle-${sequence}`,
        time: matched.mutation.time,
        projectId: 'demo-project',
        location: 'us-central1',
      }),
    });

    expect(host.triggerCount).toBe(4);
    await host.ready;

    delivery.emitCreate({ document: 'items/it-1', fields: { qty: 1 } });
    // Identical write must be suppressed before firing updated or written
    delivery.emitUpdate({ document: 'items/it-1', fields: { qty: 1 } });
    delivery.emitUpdate({ document: 'items/it-1', fields: { qty: 3 } });
    delivery.emitDelete({ document: 'items/it-1' });
    await host.idle();

    expect(log).toEqual([
      'created:it-1:{"qty":1}',
      'written:it-1:false->true',
      'updated:it-1:{"qty":1}->{"qty":3}',
      'written:it-1:true->true',
      'deleted:it-1:{"qty":3}',
      'written:it-1:true->false',
    ]);
    host.close();
  });
});
