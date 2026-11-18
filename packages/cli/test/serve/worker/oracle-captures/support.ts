/**
 * Replays SDK behavior scenarios (`packages/conformance/src/capture/sdk-scenarios/`)
 * through the served worker client and a real host over the fake port pair,
 * and compares the result with the production observation. The Node host runs
 * the same host and client code over a socket. See `replay-comparison.ts` for
 * how pins hold both answers.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getDatabase as getAdminDatabase, type Database as AdminDatabase } from 'pyric-admin/database';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  AggregateField,
  AggregateQuerySnapshot,
  aggregateFieldEqual,
  aggregateQuerySnapshotEqual,
  DocumentSnapshot,
  FieldPath,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import * as ipDatabase from 'pyric/database';
import { queryIdentifier } from 'pyric/database/internal';
import { openStorageBackend } from '../../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as client from '../../../../src/serve/worker/index.js';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { refEqual } from '../../../../src/serve/worker/client/firestore-reference-equality.js';
import { sameRtdbInstance } from '../../../../src/serve/worker/client/rtdb-references.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { handleMessage, type InboundMessage, type OutboundMessage, type PortLike } from '../../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, sleep, until } from '../integration-support.js';
import { replayTiming } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import { replayMismatches, type Behavior, type Replay } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import type {
  DatabaseSdk,
  FirestoreScenarioContext,
  FirestoreSdk,
  RtdbScenarioContext,
} from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';

export { withoutMessages, type Pin } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

export interface ServedRtdbAdminContext extends RtdbScenarioContext {
  openAdminDb(): Promise<AdminDatabase>;
}

const OBSERVATIONS = join(import.meta.dir, '..', '..', '..', '..', '..', 'conformance', 'observations');

/** The committed observation's behavior block. */
export function load(name: string): Behavior {
  let surface = 'firestore';
  if (name.startsWith('rtdb-modular-')) {
    surface = 'rtdb-modular';
  } else if (name.startsWith('auth-')) {
    surface = 'auth';
  }
  return JSON.parse(readFileSync(join(OBSERVATIONS, surface, `${name}.json`), 'utf8')).behavior as Behavior;
}

/** Frames cross the fake ports on macrotasks; give each wait time to drain. */
const servedTiming = { ...replayTiming, wait: () => sleep(150) };

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/** connectClientToHost swaps in a fake SharedWorker; put the real one back after each test. */
export function restoreSharedWorker(): void {
  let previous: unknown;
  beforeEach(() => { previous = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
  afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; });
}

export async function servedFirestoreContext(): Promise<
  FirestoreScenarioContext & { dispose(): void }
> {
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, OPEN_FIRESTORE_RULES);
  // The served entry routes these two reads through the worker client (entries/firestore-surface.ts).
  const fs = {
    ...client,
    AggregateField,
    AggregateQuerySnapshot,
    aggregateFieldEqual,
    aggregateQuerySnapshotEqual,
    DocumentSnapshot,
    FieldPath,
    QueryDocumentSnapshot,
    QuerySnapshot,
    refEqual,
    getDocFromServer: (ref: Parameters<typeof readDocumentAs>[0]) => readDocumentAs(ref, 'getDocFromServer'),
    getDocsFromServer: (source: Parameters<typeof readQueryAs>[0]) => readQueryAs(source, 'getDocsFromServer'),
  } as unknown as FirestoreSdk;
  const open = (name: string) => ({ db: connectClientToHost(ctx, `worker://capture-${name}-${Math.random()}`).db as never });
  return {
    ...servedTiming,
    fs,
    db: open('main').db,
    base: 'pyric_oracle/replay',
    deniedDocPath: 'pyric_oracle_denied_replay/x',
    newClient: async (name) => open(name),
    dispose: () => ctx.sandbox.dispose(),
  };
}

/** The worker client's RTDB functions under their modular names, as the served entry exports them. */
function databaseSdk(): DatabaseSdk {
  const named: Record<string, unknown> = {};
  const prefix = 'rtdb';
  for (const [key, value] of Object.entries(client)) {
    if (!key.startsWith(prefix) || typeof value !== 'function') continue;
    const name = key.slice(prefix.length);
    named[name.charAt(0).toLowerCase() + name.slice(1)] = value;
  }
  // The served entry builds queries with pyric/database over worker refs (entries/database-surface.ts).
  const constraints = [
    'orderByChild',
    'orderByValue',
    'orderByKey',
    'orderByPriority',
    'limitToFirst',
    'limitToLast',
    'startAt',
    'startAfter',
    'endAt',
    'endBefore',
    'equalTo',
  ] as const;
  for (const name of constraints) named[name] = ipDatabase[name];
  named.query = (
    target: Parameters<typeof ipDatabase.query>[0],
    ...items: Parameters<typeof ipDatabase.query>[1][]
  ) => {
    const built = ipDatabase.query(target, ...items);
    return {
      ...built,
      isEqual(other: ipDatabase.Query | null) {
        if (!other || typeof other !== 'object' || !('ref' in other) || !('_spec' in other)) {
          return false;
        }
        return Boolean(other.ref && typeof other.ref === 'object')
          && 'port' in built.ref
          && 'port' in other.ref
          && built.ref.port === other.ref.port
          && sameRtdbInstance(built.ref as never, other.ref as never)
          && built.ref._path === other.ref._path
          && queryIdentifier(built._spec) === queryIdentifier(other._spec);
      },
    };
  };
  return named as unknown as DatabaseSdk;
}

const OPEN_DATABASE_RULES: Record<string, unknown> = {
  rules: { '.read': true, '.write': true },
};

const hostedCleanups: Array<() => Promise<void> | void> = [];
let adminAppCounter = 0;

afterEach(async () => {
  for (const cleanup of hostedCleanups.splice(0)) {
    await cleanup();
  }
});

function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

export async function servedRtdbContext(
  databaseRules: Record<string, unknown> = OPEN_DATABASE_RULES,
): Promise<ServedRtdbAdminContext> {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, databaseRules);
  const rtdb = databaseSdk();
  const open = (name: string) => ({ db: rtdb.getDatabase(connectClientToHost(ctx, `worker://capture-${name}-${Math.random()}`).db as never) });

  const openAdminDb = async (): Promise<AdminDatabase> => {
    let deliver: (message: BridgeMessage) => void = () => {};
    const relayPort: PortLike = {
      postMessage(raw: unknown) {
        const message = raw as OutboundMessage;
        if (message.t === 'res') {
          let reply: BridgeMessage;
          if (message.ok) {
            reply = { type: 'worker-res', id: message.id, ok: true, value: message.value };
          } else {
            reply = { type: 'worker-res', id: message.id, ok: false, error: message.error };
          }
          deliver(overWire(reply));
        } else if (message.t === 'snap') {
          deliver(overWire({ type: 'worker-snap', subId: message.subId, value: message.value }));
        }
      },
    };
    const core = createRemoteSandboxCore(
      {
        send(rawMessage) {
          const wire = overWire(rawMessage);
          if (wire.type === 'attach') {
            queueMicrotask(() => {
              deliver({
                type: 'attach-ack',
                protocol: 1,
                bridgeVersion: 'test',
                peerConnected: true,
                clientSessionId: 'served-admin-relay',
                capabilities: ['worker-relay'],
              });
            });
          } else if (wire.type === 'worker-op') {
            void handleMessage(ctx, relayPort, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
          } else if (wire.type === 'worker-sub') {
            void handleMessage(ctx, relayPort, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
          } else if (wire.type === 'worker-unsub') {
            void handleMessage(ctx, relayPort, { t: 'unsub', subId: wire.subId } as InboundMessage);
          }
        },
      },
      { serveUrl: 'http://localhost:5000' },
    );
    deliver = core.handleMessage;
    core.start();
    await core.ready;
    const remote = createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl: 'http://localhost:5000',
      close: () => core.dispose('closed'),
    });
    adminAppCounter += 1;
    const adminApp = initializeAdminApp({ sandbox: remote }, `served-oracle-admin-${adminAppCounter}`);
    hostedCleanups.push(async () => {
      await deleteAdminApp(adminApp);
      core.dispose('closed');
    });
    return getAdminDatabase(adminApp);
  };

  return {
    ...servedTiming,
    rtdb,
    db: open('main').db,
    base: '/pyric_oracle/replay',
    newClient: async (name) => open(name),
    openAdminDb,
  };
}

/**
 * Replays an RTDB scenario against `createHostedRuntime` (the Node host plane)
 * over loopback WebSockets wired through `getHostedFirestore` and `pyric-admin`.
 */
export async function hostedRtdbContext(
  databaseRules: Record<string, unknown> = OPEN_DATABASE_RULES,
): Promise<ServedRtdbAdminContext> {
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-hosted-rtdb-capture-'));
  const sockets = new Map<string, { send(data: string): void }>();
  const clientPorts: Array<{ close(): void }> = [];
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-hosted-rtdb-${Math.random()}`),
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
      databaseRules,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: 'oracle-hosted',
      sessionToken: 'tok-hosted-rtdb',
      appOptions: { projectId: 'demo-oracle' },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      if (
        frame.type !== 'worker-message-result'
        && frame.type !== 'worker-res'
        && frame.type !== 'worker-snap'
      ) {
        return;
      }
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
      const sessionId = `hosted-rtdb-${++nextSession}`;
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
            projectKey: 'oracle-hosted',
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
        if (
          message.type === 'worker-op'
          || message.type === 'worker-sub'
          || message.type === 'worker-unsub'
        ) {
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

  const openAdminDb = async (): Promise<AdminDatabase> => {
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
    const remote = createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl,
      close: () => {
        core.dispose('closed');
        ws.close();
      },
    });
    adminAppCounter += 1;
    const adminApp = initializeAdminApp({ sandbox: remote }, `hosted-oracle-admin-${adminAppCounter}`);
    clientPorts.push({
      close() {
        core.dispose('closed');
        ws.close();
      },
    });
    hostedCleanups.unshift(async () => {
      await deleteAdminApp(adminApp);
    });
    return getAdminDatabase(adminApp);
  };

  hostedCleanups.push(async () => {
    for (const port of clientPorts.splice(0)) {
      try {
        port.close();
      } catch {
        // Ignore already-closed client socket ports during teardown.
      }
    }
    await runtime.close();
    await server.stop(true);
    rmSync(projectDir, { recursive: true, force: true });
  });

  const rtdb = databaseSdk();
  const openHostedClient = async (label: string) => {
    let attached = false;
    const clientDb = getHostedFirestore({
      url: wsUrl,
      projectKey: 'oracle-hosted',
      retryInitialConnection: false,
      onConnection: (state) => {
        if (state === 'attached') attached = true;
      },
    });
    clientPorts.push(clientDb.port);
    await until(() => attached, `hosted RTDB attach (${label})`);
    return { db: rtdb.getDatabase(clientDb as never) };
  };

  const main = await openHostedClient('main');
  return {
    ...servedTiming,
    rtdb,
    db: main.db,
    base: '/pyric_oracle/replay',
    newClient: (name) => openHostedClient(name),
    openAdminDb,
  };
}

export function expectReplay(replay: Replay): void {
  expect(replayMismatches(replay)).toEqual([]);
}
