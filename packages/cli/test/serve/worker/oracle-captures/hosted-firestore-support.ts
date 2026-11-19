import 'fake-indexeddb/auto';
import { afterEach } from 'bun:test';
import { WebSocket } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  AbstractUserDataWriter,
  AggregateField,
  AggregateQuerySnapshot,
  aggregateFieldEqual,
  aggregateQuerySnapshotEqual,
  Bytes,
  CACHE_SIZE_UNLIMITED,
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  documentId,
  FieldPath,
  Firestore,
  FirestoreError,
  GeoPoint,
  LoadBundleTask,
  Query,
  QueryCompositeFilterConstraint,
  QueryConstraint,
  QueryDocumentSnapshot,
  QueryEndAtConstraint,
  QueryFieldFilterConstraint,
  QueryLimitConstraint,
  QueryOrderByConstraint,
  QuerySnapshot,
  QueryStartAtConstraint,
  SnapshotMetadata,
  Timestamp,
  Transaction,
  VectorValue,
  vector,
  WriteBatch,
} from 'pyric/firestore';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { openStorageBackend } from '../../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as client from '../../../../src/serve/worker/index.js';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import {
  clearIndexedDbPersistence,
  documentSnapshotFromJSON,
  loadBundle,
  namedQuery,
  onSnapshotResume,
  querySnapshotFromJSON,
} from '../../../../src/serve/worker/client/firestore-bundles-ssr.js';
import { refEqual } from '../../../../src/serve/worker/client/firestore-reference-equality.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { sleep, until } from '../integration-support.js';
import { replayTiming } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import type {
  FirestoreScenarioContext,
  FirestoreSdk,
} from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../../../scripts/lib/private-job-tmpdir.ts';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{doc=**} { allow read, write: if collection != 'pyric_oracle_denied_replay'; }
  }
}`;

const hostedTiming = { ...replayTiming, wait: () => sleep(150) };

const hostedCleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of hostedCleanups.splice(0)) {
    await cleanup();
  }
});

function buildHostedFirestoreSdk(): FirestoreSdk {
  return {
    ...client,
    AbstractUserDataWriter,
    AggregateField,
    AggregateQuerySnapshot,
    aggregateFieldEqual,
    aggregateQuerySnapshotEqual,
    CACHE_SIZE_UNLIMITED,
    CollectionReference,
    DocumentReference,
    DocumentSnapshot,
    documentId,
    FieldPath,
    Firestore,
    FirestoreError,
    GeoPoint,
    Bytes,
    LoadBundleTask,
    Query,
    QueryCompositeFilterConstraint,
    QueryConstraint,
    QueryDocumentSnapshot,
    QueryEndAtConstraint,
    QueryFieldFilterConstraint,
    QueryLimitConstraint,
    QueryOrderByConstraint,
    QuerySnapshot,
    QueryStartAtConstraint,
    SnapshotMetadata,
    Timestamp,
    Transaction,
    VectorValue,
    vector,
    WriteBatch,
    refEqual,
    clearIndexedDbPersistence,
    loadBundle,
    namedQuery,
    documentSnapshotFromJSON,
    querySnapshotFromJSON,
    onSnapshotResume,
    getDocFromCache: (ref: Parameters<typeof readDocumentAs>[0]) => readDocumentAs(ref, 'getDocFromCache'),
    getDocsFromCache: (source: Parameters<typeof readQueryAs>[0]) => readQueryAs(source, 'getDocsFromCache'),
    getDocFromServer: (ref: Parameters<typeof readDocumentAs>[0]) => readDocumentAs(ref, 'getDocFromServer'),
    getDocsFromServer: (source: Parameters<typeof readQueryAs>[0]) => readQueryAs(source, 'getDocsFromServer'),
  } as unknown as FirestoreSdk;
}

export interface HostedFirestoreScenarioContext extends FirestoreScenarioContext {
  openRemoteAdminFirestore(): Promise<ReturnType<typeof getAdminFirestore>>;
}

/**
 * Replays a Firestore scenario against `createHostedRuntime` (the Node host
 * plane) over loopback JSON WebSockets wired through `getHostedFirestore` and
 * `createRemoteSandboxCore`.
 */
export async function hostedFirestoreContext(): Promise<HostedFirestoreScenarioContext> {
  const projectDir = createPrivateJobTmpDir('hosted-firestore-capture');
  const sockets = new Map<string, { send(data: string): void }>();
  const clientPorts: Array<{ close(): void }> = [];
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-hosted-fs-${Math.random()}`),
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
  const runtime = await createHostedRuntime(
    {
      rules: OPEN_FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: 'oracle-hosted-firestore',
      sessionToken: 'tok-hosted-firestore',
      appOptions: { projectId: 'demo-oracle' },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const forwardsToSocket = frame.type === 'worker-message-result'
        || frame.type === 'worker-res'
        || frame.type === 'worker-snap';
      if (!forwardsToSocket) return;
      const sessionId = frame.clientSessionId;
      if (typeof sessionId !== 'string') return;
      const socket = sockets.get(sessionId);
      if (socket !== undefined) {
        socket.send(JSON.stringify(frame));
      }
    },
    projectDir,
    { persistence: persistence as never, record: false },
  );

  let nextSession = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      const sessionId = `hosted-fs-${++nextSession}`;
      if (bunServer.upgrade(request, { data: { sessionId } })) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.set(socket.data.sessionId, socket);
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as BridgeMessage;
        if (message.type === 'attach') {
          socket.send(JSON.stringify({
            type: 'attach-ack',
            protocol: 1,
            bridgeVersion: 'test',
            peerConnected: true,
            clientSessionId: socket.data.sessionId,
            projectKey: 'oracle-hosted-firestore',
            hostInstanceId: runtime.instanceId,
            capabilities: ['worker-port', 'worker-relay'],
          } satisfies BridgeMessage));
          return;
        }
        if (message.type === 'worker-message') {
          runtime.receive({
            type: 'worker-message',
            clientSessionId: socket.data.sessionId,
            message: message.message,
            platform: 'node',
          });
          return;
        }
        const isRelayFrame = message.type === 'worker-op'
          || message.type === 'worker-sub'
          || message.type === 'worker-unsub';
        if (isRelayFrame) {
          runtime.receive({
            ...message,
            clientSessionId: socket.data.sessionId,
          });
        }
      },
      close(socket) {
        sockets.delete(socket.data.sessionId);
        runtime.receive({
          type: 'worker-client-disconnect',
          clientSessionId: socket.data.sessionId,
        });
      },
    },
  });

  const wsUrl = `ws://127.0.0.1:${server.port}/__pyric/sandbox`;
  const serveUrl = `http://127.0.0.1:${server.port}`;

  hostedCleanups.push(async () => {
    for (const port of clientPorts.splice(0)) {
      try {
        port.close();
      } catch {
        // Ignore already-closed socket ports during teardown.
      }
    }
    await runtime.close();
    await server.stop(true);
    removePrivateJobTmpDir(projectDir);
  });

  const openHostedClient = async (label: string) => {
    let attached = false;
    const clientDb = getHostedFirestore({
      url: wsUrl,
      projectKey: 'oracle-hosted-firestore',
      retryInitialConnection: false,
      onConnection: (state) => {
        if (state === 'attached') attached = true;
      },
    });
    clientPorts.push(clientDb.port);
    await until(() => attached, `hosted Firestore attach (${label})`);
    return { db: clientDb as never };
  };

  const openRemoteAdminFirestore = async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const core = createRemoteSandboxCore(
      {
        send(msg) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        },
      },
      { serveUrl },
    );
    ws.on('message', (data) => {
      core.handleMessage(JSON.parse(String(data)) as BridgeMessage);
    });
    core.start();
    await core.ready;
    clientPorts.push({
      close() {
        core.dispose('closed');
        ws.close();
      },
    });
    const handle = createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl,
      close: () => {
        core.dispose('closed');
        ws.close();
      },
    });
    return getAdminFirestore(handle.withAuth(null));
  };

  const fs = buildHostedFirestoreSdk();
  const main = await openHostedClient('main');
  return {
    ...hostedTiming,
    fs,
    db: main.db,
    base: 'pyric_oracle/replay',
    deniedDocPath: 'pyric_oracle_denied_replay/x',
    newClient: (name) => openHostedClient(name),
    openRemoteAdminFirestore,
  };
}
