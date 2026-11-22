/**
 * Worker client & host named-database tests:
 * - `refEqual`, `queryEqual`, and `snapshotEqual` include `databaseId`
 * - worker `loadBundle`, `namedQuery`, `documentSnapshotFromJSON`, and
 *   `querySnapshotFromJSON` route per database and reject cross-database data
 * - worker `getSnapshot`, `exportState`/`importState`, and `checkpoint`/`restore`
 *   preserve declared named databases, per-database rules, and isolated documents.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import {
  collection as sandboxCollection,
  doc as sandboxDoc,
  getDoc as sandboxGetDoc,
  getFirestore as getSandboxFirestore,
  query as sandboxQuery,
  queryEqual,
  setDoc as sandboxSetDoc,
  snapshotEqual,
  where as sandboxWhere,
} from 'pyric/firestore';
import { declareFirestoreDatabase, getDatabaseEnv } from 'pyric/firestore/internal';

import {
  collection,
  doc,
  exportWorkerState,
  getDoc,
  getDocs,
  getSnapshot,
  importWorkerState,
  query,
  restoreWorkerCheckpoint,
  saveWorkerCheckpoint,
  setDoc,
  setFirestoreRules,
  setLens,
  where,
  withDatabaseId,
  type ClientDb,
} from '../../../src/serve/worker/index.js';
import {
  documentSnapshotFromJSON,
  loadBundle,
  namedQuery,
  querySnapshotFromJSON,
} from '../../../src/serve/worker/client/firestore-bundles-ssr.js';
import { refEqual } from '../../../src/serve/worker/client/firestore-reference-equality.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import { recordPeerWorkerProtocol } from '../../../src/serve/worker/client/protocol-version.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const REPORTS_TAGGED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth != null; }
  }
}`;

function createInMemoryWorkerPair(ctx: HostCtx): ClientDb {
  const clientListeners = new Set<(event: { data: OutboundMessage }) => void>();
  const clientPort = {
    onmessage: null as ((event: { data: OutboundMessage }) => void) | null,
    start() {},
    close() {},
    postMessage(msg: InboundMessage) {
      queueMicrotask(() => {
        void handleMessage(ctx, hostPort, msg);
      });
    },
    addEventListener(_type: 'message', fn: (event: { data: OutboundMessage }) => void) {
      clientListeners.add(fn);
    },
    removeEventListener(_type: 'message', fn: (event: { data: OutboundMessage }) => void) {
      clientListeners.delete(fn);
    },
  } as unknown as MessagePort;
  const hostPort: PortLike = {
    postMessage(msg: OutboundMessage) {
      queueMicrotask(() => {
        (clientPort as unknown as { onmessage?: ((e: { data: OutboundMessage }) => void) | null }).onmessage?.({
          data: msg,
        });
        for (const listener of clientListeners) {
          listener({ data: msg });
        }
      });
    },
  };
  wirePort(clientPort);
  clientPort.start();
  recordPeerWorkerProtocol(clientPort, 2);
  return { __kind: 'client-db', type: 'firestore', port: clientPort };
}

async function createHostCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  declareFirestoreDatabase(sandbox, 'reports');
  getDatabaseEnv(sandbox).deployRules(OPEN_RULES);
  getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_TAGGED_RULES);
  await sandbox.enablePersistence({
    key: `worker-named-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  return {
    db: getSandboxFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
    instanceId: 'worker-named-test',
  };
}

function makeReportsBundle(): string {
  const elements = [
    JSON.stringify({
      metadata: {
        id: 'b-reports',
        createTime: '2026-01-01T00:00:00.000000000Z',
        version: 1,
        totalDocuments: 1,
        totalBytes: 128,
      },
    }),
    JSON.stringify({
      namedQuery: {
        name: 'worker-reports-q',
        readTime: '2026-01-01T00:00:01.000000000Z',
        bundledQuery: {
          parent: 'projects/demo-proj/databases/reports/documents',
          structuredQuery: { from: [{ collectionId: 'items' }] },
          limitType: 'FIRST',
        },
      },
    }),
    JSON.stringify({
      documentMetadata: {
        name: 'projects/demo-proj/databases/reports/documents/items/bundled',
        readTime: '2026-01-01T00:00:01.000000000Z',
        exists: true,
        queries: ['worker-reports-q'],
      },
    }),
    JSON.stringify({
      document: {
        name: 'projects/demo-proj/databases/reports/documents/items/bundled',
        createTime: '2026-01-01T00:00:01.000000000Z',
        updateTime: '2026-01-01T00:00:01.000000000Z',
        fields: { tag: { stringValue: 'from-reports-bundle' } },
      },
    }),
  ];
  return elements.map((el) => `${new TextEncoder().encode(el).byteLength}${el}`).join('');
}

describe('worker named-database equality, bundles, state transfer, and checkpoints', () => {
  afterEach(() => {
    setLens(undefined);
  });

  it('compares databaseId in worker refEqual, queryEqual, and snapshotEqual', async () => {
    const ctx = await createHostCtx();
    const defaultDb = createInMemoryWorkerPair(ctx);
    const reportsDb = withDatabaseId(defaultDb, 'reports');
    setLens({ mode: 'admin' });

    expect(refEqual(doc(defaultDb, 'items/shared'), doc(defaultDb, 'items/shared'))).toBe(true);
    expect(refEqual(doc(reportsDb, 'items/shared'), doc(reportsDb, 'items/shared'))).toBe(true);
    expect(refEqual(doc(defaultDb, 'items/shared'), doc(reportsDb, 'items/shared'))).toBe(false);
    expect(
      refEqual(collection(defaultDb, 'items'), collection(reportsDb, 'items')),
    ).toBe(false);

    const inProcDefault = getSandboxFirestore(ctx.sandbox);
    const inProcReports = getSandboxFirestore(ctx.sandbox, 'reports');
    const qDefault = sandboxQuery(sandboxCollection(inProcDefault, 'items'), sandboxWhere('x', '==', 1));
    const qReports = sandboxQuery(sandboxCollection(inProcReports, 'items'), sandboxWhere('x', '==', 1));
    expect(queryEqual(qDefault, qReports)).toBe(false);
    expect(
      queryEqual(
        qReports,
        sandboxQuery(sandboxCollection(inProcReports, 'items'), sandboxWhere('x', '==', 1)),
      ),
    ).toBe(true);

    const authedReports = getSandboxFirestore(ctx.sandbox.withAuth({ uid: 'u1' }), 'reports');
    await sandboxSetDoc(sandboxDoc(inProcDefault, 'items/shared'), { v: 1 });
    await sandboxSetDoc(sandboxDoc(authedReports, 'items/shared'), { v: 1 });
    const snapDefault = await sandboxGetDoc(sandboxDoc(inProcDefault, 'items/shared'));
    const snapReports = await sandboxGetDoc(sandboxDoc(authedReports, 'items/shared'));
    expect(snapshotEqual(snapDefault, snapReports)).toBe(false);
    expect(
      snapshotEqual(snapReports, await sandboxGetDoc(sandboxDoc(authedReports, 'items/shared'))),
    ).toBe(true);
  });

  it('routes worker bundles/SSR per database and round-trips checkpoints and state bundles', async () => {
    const ctx = await createHostCtx();
    const defaultDb = createInMemoryWorkerPair(ctx);
    const reportsDb = withDatabaseId(defaultDb, 'reports');
    setLens({ mode: 'admin' });

    const bundlePayload = makeReportsBundle();
    await loadBundle(reportsDb, bundlePayload);
    expect((await getDoc(doc(reportsDb, 'items/bundled'))).data()).toEqual({
      tag: 'from-reports-bundle',
    });
    expect((await getDoc(doc(defaultDb, 'items/bundled'))).exists()).toBe(false);
    expect(await namedQuery(reportsDb, 'worker-reports-q')).not.toBeNull();
    expect(await namedQuery(defaultDb, 'worker-reports-q')).toBeNull();

    let workerCrossDbBundleErr: unknown = null;
    try {
      await loadBundle(defaultDb, bundlePayload);
    } catch (err) {
      workerCrossDbBundleErr = err;
    }
    expect(String((workerCrossDbBundleErr as Error | null)?.message ?? '')).toContain(
      'Tried to deserialize key from different database: reports vs (default)',
    );

    const reportsSnap = await getDoc(doc(reportsDb, 'items/bundled'));
    const json = reportsSnap.toJSON();
    expect(documentSnapshotFromJSON(reportsDb, json).data()).toEqual({
      tag: 'from-reports-bundle',
    });
    expect(() => documentSnapshotFromJSON(defaultDb, json)).toThrow(
      /Tried to deserialize key from different database: reports vs \(default\)/,
    );
    const reportsQueryJson = (await getDocs(collection(reportsDb, 'items'))).toJSON();
    expect(() => querySnapshotFromJSON(defaultDb, reportsQueryJson)).toThrow(
      /Tried to deserialize key from different database: reports vs \(default\)/,
    );

    await setDoc(doc(defaultDb, 'items/shared'), { plane: 'default' });
    await setFirestoreRules(defaultDb, REPORTS_TAGGED_RULES, 'reports');

    const snapshot = (await getSnapshot(defaultDb)) as unknown as {
      firestoreDeclared?: string[];
      firestoreDatabases?: Record<string, Record<string, unknown>>;
    };
    expect(snapshot.firestoreDeclared).toEqual(['reports']);
    expect(Object.keys(snapshot.firestoreDatabases?.reports ?? {})).toContain('items/bundled');

    await saveWorkerCheckpoint(defaultDb, 'before-wipe');
    const exported = await exportWorkerState(defaultDb);

    await setDoc(doc(reportsDb, 'items/bundled'), { tag: 'mutated' });
    await restoreWorkerCheckpoint(defaultDb, 'before-wipe');
    expect((await getDoc(doc(reportsDb, 'items/bundled'))).data()).toEqual({
      tag: 'from-reports-bundle',
    });

    const freshCtx = await createHostCtx();
    const freshDefaultDb = createInMemoryWorkerPair(freshCtx);
    const freshReportsDb = withDatabaseId(freshDefaultDb, 'reports');
    await importWorkerState(freshDefaultDb, exported);
    const freshDocs = await getDocs(collection(freshReportsDb, 'items'));
    expect(freshDocs.docs.map((d) => d.id)).toEqual(['bundled']);
  });
});
