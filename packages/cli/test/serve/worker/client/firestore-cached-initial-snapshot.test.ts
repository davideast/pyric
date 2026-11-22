/**
 * Issue #1355 regression suite: a metadata listener (`includeMetadataChanges: true`)
 * on data this client just wrote gets its first snapshot from the local cache
 * (`fromCache: true`) followed by the server snapshot (`fromCache: false`), with
 * matching `docChanges({ includeMetadataChanges: true })` parity across both
 * the in-page sandbox and served worker planes. Untouched data and non-metadata
 * listeners deliver a single server snapshot (`fromCache: false`).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import * as inPage from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import * as workerClient from '../../../../src/serve/worker/client.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

interface DocObservation {
  readonly fromCache: boolean;
  readonly hasPendingWrites: boolean;
  readonly data: Record<string, unknown> | undefined;
}

interface QueryObservation {
  readonly fromCache: boolean;
  readonly docFromCache: boolean | undefined;
  readonly changes: string[];
  readonly metaChanges: string[];
}

function waitTicks(ms = 40): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('issue #1355: metadata listener cached initial snapshot parity across in-page and worker planes', () => {
  it('delivers [fromCache: true, fromCache: false] with matching metadata docChanges on locally written data', async () => {
    // In-page sandbox plane
    const sbInPage = initializeSandbox();
    getAdminCompatFirestore(sbInPage.withAuth({ uid: 'u1' })).setRules(OPEN_RULES);
    const dbInPage = inPage.getFirestore(sbInPage);

    await inPage.setDoc(inPage.doc(dbInPage, 'items/a'), { n: 1 });

    const inPageDocEvents: DocObservation[] = [];
    const inPageQueryEvents: QueryObservation[] = [];
    const inPageDefaultEvents: DocObservation[] = [];

    const stopIpDoc = inPage.onSnapshot(
      inPage.doc(dbInPage, 'items/a'),
      { includeMetadataChanges: true },
      (snap) => {
        inPageDocEvents.push({
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          data: snap.data() as Record<string, unknown> | undefined,
        });
      },
    );
    const stopIpQuery = inPage.onSnapshot(
      inPage.collection(dbInPage, 'items'),
      { includeMetadataChanges: true },
      (snap) => {
        inPageQueryEvents.push({
          fromCache: snap.metadata.fromCache,
          docFromCache: snap.docs[0]?.metadata.fromCache,
          changes: snap.docChanges().map((c) => `${c.type}:${c.doc.id}:${c.doc.metadata.fromCache}`),
          metaChanges: snap
            .docChanges({ includeMetadataChanges: true })
            .map((c) => `${c.type}:${c.doc.id}:${c.doc.metadata.fromCache}`),
        });
      },
    );
    const stopIpDefault = inPage.onSnapshot(
      inPage.doc(dbInPage, 'items/a'),
      (snap) => {
        inPageDefaultEvents.push({
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          data: snap.data() as Record<string, unknown> | undefined,
        });
      },
    );

    const inPageColdEvents: DocObservation[] = [];
    const stopIpCold = inPage.onSnapshot(
      inPage.doc(dbInPage, 'untouched/u1'),
      { includeMetadataChanges: true },
      (snap) => {
        inPageColdEvents.push({
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          data: snap.data() as Record<string, unknown> | undefined,
        });
      },
    );

    await waitTicks();
    stopIpDoc();
    stopIpQuery();
    stopIpDefault();
    stopIpCold();
    sbInPage.dispose();

    // Served worker plane
    const sbWorker = initializeSandbox();
    getAdminCompatFirestore(sbWorker.withAuth({ uid: 'u1' })).setRules(OPEN_RULES);
    const ctx: HostCtx = {
      sandbox: sbWorker,
      db: inPage.getFirestore(sbWorker),
      instanceId: 'cached-init-snap-1355',
      subs: new Map(),
    };
    const hostPort: PortLike = {
      postMessage(message: OutboundMessage) {
        queueMicrotask(() => {
          clientPort.onmessage?.(new MessageEvent('message', { data: message }));
        });
      },
    };
    const clientPort: ClientPort = {
      onmessage: null,
      postMessage(message: InboundMessage) {
        queueMicrotask(() => {
          void handleMessage(ctx, hostPort, message);
        });
      },
      start() {},
      close() {
        clientPort.onmessage = null;
      },
    };
    const prevSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor() {}
    };

    const workerDocEvents: DocObservation[] = [];
    const workerQueryEvents: QueryObservation[] = [];
    const workerDefaultEvents: DocObservation[] = [];
    const workerColdEvents: DocObservation[] = [];

    try {
      const wdb = workerClient.getFirestore('worker://cached-init-snap-1355');
      await workerClient.setDoc(workerClient.doc(wdb, 'items/a'), { n: 1 });

      const stopWkDoc = workerClient.onSnapshot(
        workerClient.doc(wdb, 'items/a'),
        { includeMetadataChanges: true },
        (snap) => {
          const docSnap = snap as workerClient.ClientDocSnapshot;
          workerDocEvents.push({
            fromCache: docSnap.metadata.fromCache,
            hasPendingWrites: docSnap.metadata.hasPendingWrites,
            data: docSnap.data() as Record<string, unknown> | undefined,
          });
        },
      );
      const stopWkQuery = workerClient.onSnapshot(
        workerClient.collection(wdb, 'items'),
        { includeMetadataChanges: true },
        (snap) => {
          const querySnap = snap as workerClient.ClientQuerySnapshot;
          workerQueryEvents.push({
            fromCache: querySnap.metadata.fromCache,
            docFromCache: querySnap.docs[0]?.metadata.fromCache,
            changes: querySnap.docChanges().map((c) => `${c.type}:${c.doc.id}:${c.doc.metadata.fromCache}`),
            metaChanges: querySnap
              .docChanges({ includeMetadataChanges: true })
              .map((c) => `${c.type}:${c.doc.id}:${c.doc.metadata.fromCache}`),
          });
        },
      );
      const stopWkDefault = workerClient.onSnapshot(
        workerClient.doc(wdb, 'items/a'),
        (snap) => {
          const docSnap = snap as workerClient.ClientDocSnapshot;
          workerDefaultEvents.push({
            fromCache: docSnap.metadata.fromCache,
            hasPendingWrites: docSnap.metadata.hasPendingWrites,
            data: docSnap.data() as Record<string, unknown> | undefined,
          });
        },
      );
      const stopWkCold = workerClient.onSnapshot(
        workerClient.doc(wdb, 'untouched/u1'),
        { includeMetadataChanges: true },
        (snap) => {
          const docSnap = snap as workerClient.ClientDocSnapshot;
          workerColdEvents.push({
            fromCache: docSnap.metadata.fromCache,
            hasPendingWrites: docSnap.metadata.hasPendingWrites,
            data: docSnap.data() as Record<string, unknown> | undefined,
          });
        },
      );

      await waitTicks();
      stopWkDoc();
      stopWkQuery();
      stopWkDefault();
      stopWkCold();
    } finally {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevSharedWorker;
      clientPort.close();
      sbWorker.dispose();
    }

    const expectedDocEvents: DocObservation[] = [
      { fromCache: true, hasPendingWrites: false, data: { n: 1 } },
      { fromCache: false, hasPendingWrites: false, data: { n: 1 } },
    ];
    const expectedQueryEvents: QueryObservation[] = [
      {
        fromCache: true,
        docFromCache: true,
        changes: ['added:a:true'],
        metaChanges: ['added:a:true'],
      },
      {
        fromCache: false,
        docFromCache: false,
        changes: [],
        metaChanges: ['modified:a:false'],
      },
    ];
    const expectedDefaultEvents: DocObservation[] = [
      { fromCache: false, hasPendingWrites: false, data: { n: 1 } },
    ];
    const expectedColdEvents: DocObservation[] = [
      { fromCache: false, hasPendingWrites: false, data: undefined },
    ];

    expect(inPageDocEvents).toEqual(expectedDocEvents);
    expect(workerDocEvents).toEqual(expectedDocEvents);
    expect(inPageQueryEvents).toEqual(expectedQueryEvents);
    expect(workerQueryEvents).toEqual(expectedQueryEvents);
    expect(inPageDefaultEvents).toEqual(expectedDefaultEvents);
    expect(workerDefaultEvents).toEqual(expectedDefaultEvents);
    expect(inPageColdEvents).toEqual(expectedColdEvents);
    expect(workerColdEvents).toEqual(expectedColdEvents);
  });
});
