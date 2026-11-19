import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  doc as clientDoc,
  getDoc as clientGetDoc,
  getFirestore as getClientFirestore,
} from 'pyric/firestore';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { createObservationGate } from '../../../conformance/src/observation-gate.ts';
import {
  observeFirestoreAdminBypassAndLifecycle,
  type FirestoreAdminBypassLifecycleSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-getfirestore-bypass-and-lifecycle.ts';
import { observeFirestoreAdminPathsAndAutoIds } from '../../../conformance/probes/firestore-admin/firestore-admin-paths-and-autoids.ts';
import {
  observeFirestoreAdminSentinelsAndValues,
  type FirestoreAdminSentinelsSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-sentinels-and-value-types.ts';
import {
  classifyGrpcOrStringFirestoreError,
  observeFirestoreAdminCrud,
  type FirestoreAdminCrudSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-crud-operations.ts';
import {
  observeFirestoreAdminQueriesAndSnapshots,
  type AdminQueryCollectionRefLike,
  type AdminQueryDocRefLike,
  type AdminQueryLike,
  type FirestoreAdminQueriesSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-queries-and-snapshots.ts';
import {
  observeFirestoreAdminBatchesAndTransactions,
  type AdminWriteBatchLike,
  type BatchTxDocRefLike,
  type BatchTxQueryLike,
  type FirestoreAdminBatchesTxSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-batches-and-transactions.ts';
import {
  classifyAdminParityError,
  observeFirestoreAdminWriteResultFilterGetAll,
  type AdminCollectionRefLike,
  type AdminDocRefLike,
  type FirestoreAdminWriteResultFilterGetAllSubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-writeresult-preconditions-filter-getall.ts';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  AggregateField,
  FieldPath,
  FieldValue,
  Filter,
  getFirestore,
  Timestamp,
  type WhereFilterOp,
} from '../../src/firestore/index.js';

const SERVE_URL = 'http://localhost:5000';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore-admin',
);

const firestoreAdminObsGate = createObservationGate({
  dir: OBS_DIR,
  match: (file) => file.startsWith('firestore-admin-'),
});

const DENY_UNAUTH_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if request.auth != null;',
  '    }',
  '  }',
  '}',
].join('\n');

type ArmKind = 'local' | 'remote';

interface FirestoreOracleArm {
  readonly hostSandbox: Sandbox;
  readonly adminSandbox: Sandbox | RemoteSandbox;
  dispose(): void;
}

const activeDisposers: Array<() => void> = [];

function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

function createOracleArm(arm: ArmKind, rules?: string): FirestoreOracleArm {
  const hostSandbox = initializeSandbox({ projectId: 'proj-1' });
  if (rules !== undefined) {
    getInternalEnv(hostSandbox).deployRules(rules);
  }

  if (arm === 'local') {
    const localArm: FirestoreOracleArm = {
      hostSandbox,
      adminSandbox: hostSandbox,
      dispose(): void {
        hostSandbox.dispose();
      },
    };
    activeDisposers.push(localArm.dispose);
    return localArm;
  }

  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx: HostCtx = {
    db: getClientFirestore(hostSandbox),
    sandbox: hostSandbox,
    instanceId: `fs-admin-oracle-${Math.random().toString(36).slice(2)}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };

  let generation = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const message = raw as OutboundMessage;
      if (message.t === 'res') {
        let reply: Record<string, unknown>;
        if (message.ok) {
          reply = { type: 'worker-res', id: message.id, ok: true, value: message.value };
        } else {
          reply = { type: 'worker-res', id: message.id, ok: false, error: message.error };
        }
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
      } else if (message.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: message.subId, value: message.value }) as BridgeMessage,
          generation,
        );
      }
    },
  };

  bridge.registerSandboxPeer(
    (message: BridgeMessage) => {
      if (generation === 0) {
        generation = bridge.peerGeneration();
      }
      const wire = overWire(message);
      if (wire.type === 'worker-op') {
        void handleMessage(ctx, port, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
      } else if (wire.type === 'worker-sub') {
        void handleMessage(ctx, port, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
      } else if (wire.type === 'worker-unsub') {
        void handleMessage(ctx, port, { t: 'unsub', subId: wire.subId } as InboundMessage);
      }
    },
    [],
    'oracle-tab',
    [WORKER_RELAY_CAPABILITY],
  );

  let deliver: (message: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
  const core = createRemoteSandboxCore(
    { send: (message) => session.handleMessage(overWire(message)) },
    { serveUrl: SERVE_URL },
  );
  deliver = core.handleMessage;
  core.start();
  const remote = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('closed'),
  });

  const remoteArm: FirestoreOracleArm = {
    hostSandbox,
    adminSandbox: remote,
    dispose(): void {
      remote.close();
      hostSandbox.dispose();
    },
  };
  activeDisposers.push(remoteArm.dispose);
  return remoteArm;
}

function isDocumentRefLike(value: unknown): value is { readonly id: string; readonly path: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; path?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.path === 'string';
}

function toSentinelsSubject(db: ReturnType<typeof getFirestore>): FirestoreAdminSentinelsSubject {
  return {
    collection: (path) => db.collection(path),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    increment: (delta) => FieldValue.increment(delta),
    arrayUnion: (...elements) => FieldValue.arrayUnion(...elements),
    arrayRemove: (...elements) => FieldValue.arrayRemove(...elements),
    deleteField: () => FieldValue.delete(),
    createFieldPath: (...names) => new FieldPath(...names),
    documentIdFieldPath: () => FieldPath.documentId(),
    createTimestamp: (seconds, nanoseconds) => new Timestamp(seconds, nanoseconds),
    isTimestamp: (value): value is Timestamp => value instanceof Timestamp,
    readBytes(value: unknown): readonly number[] | null {
      if (value instanceof Uint8Array) {
        return Array.from(value);
      }
      return null;
    },
    readDocRefPath(value: unknown) {
      if (isDocumentRefLike(value)) {
        return { id: value.id, path: value.path };
      }
      return null;
    },
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose !== undefined) {
      dispose();
    }
  }
});

describe('pyric-admin/firestore oracle conformance (observations/firestore-admin)', () => {
  describe.each(['local', 'remote'] as const)('arm=%s', (arm) => {
    it('replays firestore-admin-getfirestore-bypass-and-lifecycle verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-getfirestore-bypass-and-lifecycle',
      );
      const env = createOracleArm(arm, DENY_UNAUTH_RULES);
      const clientDb = getClientFirestore(env.hostSandbox);

      const subject: FirestoreAdminBypassLifecycleSubject<
        PyricAdminApp,
        ReturnType<typeof getFirestore>
      > = {
        initializeNamedAdminApp(name: string): PyricAdminApp {
          return initializeApp({ sandbox: env.adminSandbox, projectId: 'proj-1' }, name);
        },
        getAdminFirestore(app: PyricAdminApp) {
          return getFirestore(app);
        },
        getAdminFirestoreRaw(arg: unknown) {
          return getFirestore(arg as never);
        },
        deleteAdminApp(app: PyricAdminApp) {
          return deleteApp(app);
        },
        async readProtectedViaUnauthenticatedClient(docPath: string): Promise<void> {
          await clientGetDoc(clientDoc(clientDb, docPath));
        },
        async writeViaAdmin(db, docPath: string, data: Record<string, unknown>): Promise<void> {
          await db.doc(docPath).set(data);
        },
        async readViaAdmin(db, docPath: string) {
          const snap = await db.doc(docPath).get();
          return {
            exists: snap.exists,
            data: snap.data() as Record<string, unknown> | undefined,
          };
        },
      };

      const actual = await observeFirestoreAdminBypassAndLifecycle(
        subject,
        `pyric_oracle/replay_${arm}/bypass/doc-1`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-paths-and-autoids verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-paths-and-autoids',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-paths-${arm}`,
      );
      const db = getFirestore(app);

      const actual = await observeFirestoreAdminPathsAndAutoIds(
        db,
        `pyric_oracle/replay_${arm}_paths`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-sentinels-and-value-types verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-sentinels-and-value-types',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-sentinels-${arm}`,
      );
      const db = getFirestore(app);

      const actual = await observeFirestoreAdminSentinelsAndValues(
        toSentinelsSubject(db),
        `pyric_oracle/replay_${arm}_values`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-crud-operations verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-crud-operations',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-crud-${arm}`,
      );
      const db = getFirestore(app);
      const subject: FirestoreAdminCrudSubject = {
        doc: (path) => db.doc(path),
        createFieldPath: (...names) => new FieldPath(...names),
        classifyError: classifyGrpcOrStringFirestoreError,
      };

      const actual = await observeFirestoreAdminCrud(
        subject,
        `pyric_oracle/replay_${arm}_crud`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-queries-and-snapshots verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-queries-and-snapshots',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-queries-${arm}`,
      );
      const db = getFirestore(app);
      const subject: FirestoreAdminQueriesSubject = {
        collection: (path) => db.collection(path) as unknown as AdminQueryCollectionRefLike,
        doc: (path) => db.doc(path) as unknown as AdminQueryDocRefLike,
        collectionGroup: (id) => db.collectionGroup(id) as unknown as AdminQueryLike,
      };

      const actual = await observeFirestoreAdminQueriesAndSnapshots(
        subject,
        `pyric_oracle/replay_${arm}_queries`,
        `cg_replay_${arm}`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-batches-and-transactions verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-batches-and-transactions',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-batches-tx-${arm}`,
      );
      const db = getFirestore(app);
      const subject: FirestoreAdminBatchesTxSubject = {
        doc: (path) => db.doc(path) as unknown as BatchTxDocRefLike,
        collection: (path) => db.collection(path) as unknown as BatchTxQueryLike,
        batch: () => db.batch() as unknown as AdminWriteBatchLike,
        runTransaction: (fn, opts) =>
          db.runTransaction(
            fn as unknown as Parameters<typeof db.runTransaction>[0],
            opts,
          ) as Promise<never>,
      };

      const actual = await observeFirestoreAdminBatchesAndTransactions(
        subject,
        `pyric_oracle/replay_${arm}_batches_tx`,
      );
      expect(actual).toEqual(expected);
    });

    it('replays firestore-admin-writeresult-preconditions-filter-getall verbatim', async () => {
      const expected = firestoreAdminObsGate.load<Record<string, unknown>>(
        'firestore-admin-writeresult-preconditions-filter-getall',
      );
      const env = createOracleArm(arm);
      const app = initializeApp(
        { sandbox: env.adminSandbox, projectId: 'proj-1' },
        `fs-admin-wf-${arm}`,
      );
      const db = getFirestore(app);
      const subject: FirestoreAdminWriteResultFilterGetAllSubject = {
        doc: (path) => db.doc(path) as unknown as AdminDocRefLike,
        collection: (path) => db.collection(path) as unknown as AdminCollectionRefLike,
        batch: () => db.batch() as unknown as ReturnType<FirestoreAdminWriteResultFilterGetAllSubject['batch']>,
        runTransaction: (fn) =>
          db.runTransaction(
            fn as unknown as Parameters<typeof db.runTransaction>[0],
          ) as Promise<never>,
        filterWhere: (fieldPath, opStr, value) =>
          Filter.where(fieldPath, opStr as WhereFilterOp, value),
        filterOr: (...filters) => {
          const typedFilters = filters as Filter[];
          return Filter.or(...typedFilters);
        },
        filterAnd: (...filters) => {
          const typedFilters = filters as Filter[];
          return Filter.and(...typedFilters);
        },
        aggregateCount: () => AggregateField.count(),
        aggregateSum: (field) => AggregateField.sum(field),
        aggregateAverage: (field) => AggregateField.average(field),
        epochZeroTimestamp: () => new Timestamp(0, 0),
        classifyError: classifyAdminParityError,
      };

      const actual = await observeFirestoreAdminWriteResultFilterGetAll(
        subject,
        `pyric_oracle/replay_${arm}_wf`,
      );
      expect(actual).toEqual(expected);
    });
  });

  it('completeness: every observations/firestore-admin/ capture is asserted', () => {
    const report = firestoreAdminObsGate.report();
    expect(report.committed.length).toBe(7);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
