import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  deleteDoc,
  doc as pyricDoc,
  getAdminFirestore as pyricGetAdminFirestore,
  getFirestore as getClientFirestore,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
} from 'pyric/firestore';
import {
  createMemoryBackend,
  initializeSandbox,
  type WriteSandboxEvent,
} from 'pyric/sandbox';
import { emitSandboxEvent } from 'pyric/sandbox/internal';
import type { FirestoreMutationRecord } from '../../src/functions/firestore/delivery.js';
import type { FirestoreTriggerAuthType } from '../../src/functions/firestore/event.js';
import { startFirestoreTriggerExecution } from '../../src/functions/firestore/execution.js';
import { InMemoryFirestoreTriggerDelivery } from '../../src/functions/firestore/in-memory-delivery.js';
import { RemoteFirestoreTriggerDelivery } from '../../src/functions/firestore/remote-delivery.js';
import type { RemoteSandboxChannel } from '../../src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';

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
    `functions-firestore-auth-unit-${appSeq}`,
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

interface CapturedAuthObservation {
  readonly trigger: string;
  readonly type: string;
  readonly docId: string;
  readonly authType: FirestoreTriggerAuthType;
  readonly authId: string | undefined;
  readonly v1AuthType: string | undefined;
  readonly v1AuthId: string | undefined;
  readonly v1EventType: string;
  readonly summary: string;
}

describe('Firestore v2 *WithAuthContext unit semantics and auth attribution', () => {
  test('delivers authentic authType and authId across all 4 *WithAuthContext triggers and all 5 upstream AuthType principals', async () => {
    const observed: CapturedAuthObservation[] = [];

    const onCreatedAuth = firestoreFunctions.onDocumentCreatedWithAuthContext(
      'accounts/{accountId}',
      (event) => {
        observed.push({
          trigger: 'createdAuth',
          type: event.type,
          docId: event.params.accountId,
          authType: event.authType,
          authId: event.authId,
          v1AuthType: event.context.authType,
          v1AuthId: event.context.authId,
          v1EventType: event.context.eventType,
          summary: JSON.stringify(event.data?.data()),
        });
      },
    );

    const onUpdatedAuth = firestoreFunctions.onDocumentUpdatedWithAuthContext(
      'accounts/{accountId}',
      (event) => {
        observed.push({
          trigger: 'updatedAuth',
          type: event.type,
          docId: event.params.accountId,
          authType: event.authType,
          authId: event.authId,
          v1AuthType: event.context.authType,
          v1AuthId: event.context.authId,
          v1EventType: event.context.eventType,
          summary: `${JSON.stringify(event.data?.before.data())}->${JSON.stringify(event.data?.after.data())}`,
        });
      },
    );

    const onDeletedAuth = firestoreFunctions.onDocumentDeletedWithAuthContext(
      'accounts/{accountId}',
      (event) => {
        observed.push({
          trigger: 'deletedAuth',
          type: event.type,
          docId: event.params.accountId,
          authType: event.authType,
          authId: event.authId,
          v1AuthType: event.context.authType,
          v1AuthId: event.context.authId,
          v1EventType: event.context.eventType,
          summary: JSON.stringify(event.data?.data()),
        });
      },
    );

    const onWrittenAuth = firestoreFunctions.onDocumentWrittenWithAuthContext(
      'accounts/{accountId}',
      (event) => {
        observed.push({
          trigger: 'writtenAuth',
          type: event.type,
          docId: event.params.accountId,
          authType: event.authType,
          authId: event.authId,
          v1AuthType: event.context.authType,
          v1AuthId: event.context.authId,
          v1EventType: event.context.eventType,
          summary: `${String(event.data?.before.exists)}->${String(event.data?.after.exists)}`,
        });
      },
    );

    const delivery = new InMemoryFirestoreTriggerDelivery();
    const host = startFirestoreTriggerExecution({
      exported: { onCreatedAuth, onUpdatedAuth, onDeletedAuth, onWrittenAuth },
      delivery,
      envelopeOptions: (matched, sequence) => ({
        id: `auth-seq-${sequence}`,
        time: matched.mutation.time,
        projectId: 'demo-project',
        location: 'us-central1',
      }),
    });

    expect(host.triggerCount).toBe(4);
    await host.ready;

    // 1. Authenticated user A (uid-alice) creates acc-1
    delivery.emitCreate({
      document: 'accounts/acc-1',
      fields: { owner: 'alice', tier: 'free' },
      authType: 'unknown',
      authId: 'uid-alice',
    });

    // 2. Authenticated user B (uid-bob) updates acc-1 (proving dynamic UID, never hardcoded)
    delivery.emitUpdate({
      document: 'accounts/acc-1',
      fields: { owner: 'alice', tier: 'pro' },
      authType: 'unknown',
      authId: 'uid-bob',
    });

    // 3. Admin / service_account updates acc-1
    delivery.emitUpdate({
      document: 'accounts/acc-1',
      fields: { owner: 'alice', tier: 'enterprise' },
      authType: 'service_account',
    });

    // 4. Unauthenticated client creates acc-anon
    delivery.emitCreate({
      document: 'accounts/acc-anon',
      fields: { guest: true },
      authType: 'unauthenticated',
    });

    // 5. API key principal updates acc-anon
    delivery.emitUpdate({
      document: 'accounts/acc-anon',
      fields: { guest: false },
      authType: 'api_key',
      authId: 'key-public-web',
    });

    // 6. System (TTL) deletes acc-1 and acc-anon
    delivery.emitDelete({
      document: 'accounts/acc-1',
      authType: 'system',
    });
    delivery.emitDelete({
      document: 'accounts/acc-anon',
      authType: 'unauthenticated',
    });

    await host.idle();
    host.close();

    expect(observed).toEqual([
      {
        trigger: 'createdAuth',
        type: 'google.cloud.firestore.document.v1.created.withAuthContext',
        docId: 'acc-1',
        authType: 'unknown',
        authId: 'uid-alice',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-alice',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.create',
        summary: '{"owner":"alice","tier":"free"}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-1',
        authType: 'unknown',
        authId: 'uid-alice',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-alice',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'false->true',
      },
      {
        trigger: 'updatedAuth',
        type: 'google.cloud.firestore.document.v1.updated.withAuthContext',
        docId: 'acc-1',
        authType: 'unknown',
        authId: 'uid-bob',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-bob',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.update',
        summary: '{"owner":"alice","tier":"free"}->{"owner":"alice","tier":"pro"}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-1',
        authType: 'unknown',
        authId: 'uid-bob',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-bob',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'true->true',
      },
      {
        trigger: 'updatedAuth',
        type: 'google.cloud.firestore.document.v1.updated.withAuthContext',
        docId: 'acc-1',
        authType: 'service_account',
        authId: undefined,
        v1AuthType: 'service_account',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.update',
        summary: '{"owner":"alice","tier":"pro"}->{"owner":"alice","tier":"enterprise"}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-1',
        authType: 'service_account',
        authId: undefined,
        v1AuthType: 'service_account',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'true->true',
      },
      {
        trigger: 'createdAuth',
        type: 'google.cloud.firestore.document.v1.created.withAuthContext',
        docId: 'acc-anon',
        authType: 'unauthenticated',
        authId: undefined,
        v1AuthType: 'unauthenticated',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.create',
        summary: '{"guest":true}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-anon',
        authType: 'unauthenticated',
        authId: undefined,
        v1AuthType: 'unauthenticated',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'false->true',
      },
      {
        trigger: 'updatedAuth',
        type: 'google.cloud.firestore.document.v1.updated.withAuthContext',
        docId: 'acc-anon',
        authType: 'api_key',
        authId: 'key-public-web',
        v1AuthType: 'api_key',
        v1AuthId: 'key-public-web',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.update',
        summary: '{"guest":true}->{"guest":false}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-anon',
        authType: 'api_key',
        authId: 'key-public-web',
        v1AuthType: 'api_key',
        v1AuthId: 'key-public-web',
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'true->true',
      },
      {
        trigger: 'deletedAuth',
        type: 'google.cloud.firestore.document.v1.deleted.withAuthContext',
        docId: 'acc-1',
        authType: 'system',
        authId: undefined,
        v1AuthType: 'system',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.delete',
        summary: '{"owner":"alice","tier":"enterprise"}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-1',
        authType: 'system',
        authId: undefined,
        v1AuthType: 'system',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'true->false',
      },
      {
        trigger: 'deletedAuth',
        type: 'google.cloud.firestore.document.v1.deleted.withAuthContext',
        docId: 'acc-anon',
        authType: 'unauthenticated',
        authId: undefined,
        v1AuthType: 'unauthenticated',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.delete',
        summary: '{"guest":false}',
      },
      {
        trigger: 'writtenAuth',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        docId: 'acc-anon',
        authType: 'unauthenticated',
        authId: undefined,
        v1AuthType: 'unauthenticated',
        v1AuthId: undefined,
        v1EventType: 'providers/cloud.firestore/eventTypes/document.write',
        summary: 'true->false',
      },
    ]);
  });

  test('omits authType and authId on non-withAuthContext triggers even when mutations carry authenticated principals', async () => {
    const authPresence: Array<{
      trigger: string;
      hasAuthType: boolean;
      hasAuthId: boolean;
      v1AuthType: unknown;
      v1AuthId: unknown;
    }> = [];

    const recordPlain = (trigger: string, event: Record<string, unknown>): void => {
      const context = event.context as { authType?: unknown; authId?: unknown };
      authPresence.push({
        trigger,
        hasAuthType: 'authType' in event,
        hasAuthId: 'authId' in event,
        v1AuthType: context.authType,
        v1AuthId: context.authId,
      });
    };

    const plainCreated = firestoreFunctions.onDocumentCreated('docs/{id}', (ev) => {
      recordPlain('created', ev as unknown as Record<string, unknown>);
    });
    const plainUpdated = firestoreFunctions.onDocumentUpdated('docs/{id}', (ev) => {
      recordPlain('updated', ev as unknown as Record<string, unknown>);
    });
    const plainDeleted = firestoreFunctions.onDocumentDeleted('docs/{id}', (ev) => {
      recordPlain('deleted', ev as unknown as Record<string, unknown>);
    });
    const plainWritten = firestoreFunctions.onDocumentWritten('docs/{id}', (ev) => {
      recordPlain('written', ev as unknown as Record<string, unknown>);
    });

    const delivery = new InMemoryFirestoreTriggerDelivery();
    const host = startFirestoreTriggerExecution({
      exported: { plainCreated, plainUpdated, plainDeleted, plainWritten },
      delivery,
      envelopeOptions: (matched, sequence) => ({
        id: `plain-${sequence}`,
        time: matched.mutation.time,
        projectId: 'demo-project',
        location: 'us-central1',
      }),
    });
    await host.ready;

    delivery.emitCreate({
      document: 'docs/d-1',
      fields: { step: 1 },
      authType: 'unknown',
      authId: 'uid-alice',
    });
    delivery.emitUpdate({
      document: 'docs/d-1',
      fields: { step: 2 },
      authType: 'service_account',
    });
    delivery.emitDelete({
      document: 'docs/d-1',
      authType: 'unknown',
      authId: 'uid-bob',
    });
    await host.idle();
    host.close();

    expect(authPresence.length).toBe(6);
    for (const entry of authPresence) {
      expect(entry.hasAuthType).toBe(false);
      expect(entry.hasAuthId).toBe(false);
      expect(entry.v1AuthType).toBeUndefined();
      expect(entry.v1AuthId).toBeUndefined();
    }
  });

  test('derives authentic authType and authId over RemoteFirestoreTriggerDelivery across AuthLens, anon, admin, batch, transaction, and system events', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `firestore-auth-remote-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });

    try {
      const ctx: HostCtx = {
        db: getClientFirestore(sandbox),
        sandbox,
        instanceId: 'test-auth-remote-delivery',
        subs: new Map(),
        messagingEnabled: false,
      };
      let nextSubSeq = 0;
      const listeners = new Map<string, (snap: unknown) => void>();
      const port: PortLike = {
        postMessage(raw: unknown) {
          const msg = raw as OutboundMessage;
          if (msg.t === 'snap') {
            listeners.get(msg.subId)?.(msg.value);
          }
        },
      };
      const channel: Pick<RemoteSandboxChannel, 'subscribe'> = {
        subscribe(sub, onSnap) {
          const subId = `auth-sub-${(nextSubSeq += 1)}`;
          listeners.set(subId, onSnap);
          void handleMessage(ctx, port, {
            ...sub,
            t: 'sub',
            subId,
          } as InboundMessage);
          return () => {
            listeners.delete(subId);
            void handleMessage(ctx, port, { t: 'unsub', subId });
          };
        },
      };

      const delivery = new RemoteFirestoreTriggerDelivery(channel);
      const records: FirestoreMutationRecord[] = [];
      const stop = delivery.subscribe('(default)', {
        onMutation(mutation) {
          records.push(mutation);
        },
      });

      const aliceDb = getClientFirestore(sandbox.withAuth({ uid: 'uid-alice' }));
      const bobDb = getClientFirestore(sandbox.withAuth({ uid: 'uid-bob' }));
      const anonDb = getClientFirestore(sandbox.withAuth(null));
      const adminDb = pyricGetAdminFirestore(sandbox);

      await setDoc(pyricDoc(aliceDb, 'items/a'), { by: 'alice' });

      const bobBatch = writeBatch(bobDb);
      bobBatch.set(pyricDoc(bobDb, 'items/b'), { step: 1 });
      bobBatch.update(pyricDoc(bobDb, 'items/b'), { step: 2 });
      await bobBatch.commit();

      await runTransaction(aliceDb, async (tx) => {
        tx.update(pyricDoc(aliceDb, 'items/a'), { by: 'alice-tx' });
      });

      await setDoc(pyricDoc(anonDb, 'items/anon'), { guest: true });
      await updateDoc(pyricDoc(adminDb, 'items/anon'), { guest: false, reviewed: true });
      await deleteDoc(pyricDoc(bobDb, 'items/b'));

      // Explicit system (e.g. TTL) and api_key write events on sandbox stream
      const ttlDeleteEvent: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-ttl-1',
        at: Date.now(),
        method: 'delete',
        path: 'items/anon',
        auth: null,
        priorState: { guest: false, reviewed: true },
        nextState: null,
        requestTime: { seconds: 1_725_000_100, nanoseconds: 0 },
        detail: { authType: 'system' },
      };
      emitSandboxEvent(sandbox, ttlDeleteEvent);

      const apiKeyCreateEvent: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-apikey-1',
        at: Date.now(),
        method: 'create',
        path: 'items/keyed',
        auth: null,
        priorState: null,
        nextState: { source: 'api-key' },
        requestTime: { seconds: 1_725_000_200, nanoseconds: 0 },
        detail: { authType: 'api_key', authId: 'key-42' },
      };
      emitSandboxEvent(sandbox, apiKeyCreateEvent);
      await Promise.resolve();

      expect(
        records.map((r) => ({
          document: r.document,
          authType: r.authType,
          authId: r.authId,
        })),
      ).toEqual([
        { document: 'items/a', authType: 'unknown', authId: 'uid-alice' },
        { document: 'items/b', authType: 'unknown', authId: 'uid-bob' },
        { document: 'items/a', authType: 'unknown', authId: 'uid-alice' },
        { document: 'items/anon', authType: 'unauthenticated', authId: undefined },
        { document: 'items/anon', authType: 'service_account', authId: undefined },
        { document: 'items/b', authType: 'unknown', authId: 'uid-bob' },
        { document: 'items/anon', authType: 'system', authId: undefined },
        { document: 'items/keyed', authType: 'api_key', authId: 'key-42' },
      ]);

      stop();
    } finally {
      sandbox.dispose();
    }
  });
});
