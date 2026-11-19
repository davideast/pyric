import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getDatabase as ipGetDatabase, sandbox as ipDatabaseSandbox } from 'pyric/database';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import { openStorageBackend } from '../../../pyric/dist/storage/persistence.js';
import type { BridgeMessage } from '../../../cli/dist/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../cli/dist/remote/index.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import * as workerSurface from '../../../cli/dist/serve/worker/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../cli/dist/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/dist/serve/worker/protocol.js';
import { setDatabaseRules as setHostDatabaseRules } from '../../../cli/dist/serve/worker/host/rules.js';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const OPEN_STORAGE_RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

interface FakePort {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  addEventListener(type: string, fn: () => void): void;
}

function makePortPair(): { clientPort: FakePort; hostPort: FakePort } {
  const clientPort: FakePort = {
    onmessage: null,
    postMessage() {},
    start() {},
    close() {},
    addEventListener() {},
  };
  const hostPort: FakePort = {
    onmessage: null,
    postMessage() {},
    start() {},
    close() {},
    addEventListener() {},
  };
  clientPort.postMessage = (msg) => {
    setTimeout(() => {
      hostPort.onmessage?.({ data: msg });
    }, 0);
  };
  hostPort.postMessage = (msg) => {
    setTimeout(() => {
      clientPort.onmessage?.({ data: msg });
    }, 0);
  };
  return { clientPort, hostPort };
}

function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

export interface ServedPlaneHarness {
  readonly mainDb: workerSurface.ClientRtdb;
  openClient(label: string): Promise<{ raw: workerSurface.ClientDb; db: workerSurface.ClientRtdb }>;
  openRemote(): Promise<ReturnType<typeof createRemoteSandboxHandle>>;
}

const cleanups: Array<() => Promise<void> | void> = [];

export function registerServedRtdbHooks(): void {
  let savedSharedWorker: unknown;
  beforeEach(() => {
    savedSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  });
  afterEach(async () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = savedSharedWorker;
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openSharedWorkerHarness(
  initialRules: { rules: Record<string, unknown> },
): Promise<ServedPlaneHarness> {
  const sandbox = initializeSandbox();
  ipDatabaseSandbox.setDefaultPolicy(ipGetDatabase(sandbox), 'allow');
  getStorageSandbox(sandbox, {
    dbName: `worker-stdlib-${Math.random().toString(36).slice(2)}`,
    rules: OPEN_STORAGE_RULES,
  });
  setFirestoreRules(sandbox, OPEN_FIRESTORE_RULES);
  await sandbox.enablePersistence({
    key: `worker-stdlib-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  ipGetAuth(sandbox);

  const ctx: HostCtx = {
    instanceId: `worker-stdlib-host-${Math.random().toString(36).slice(2)}`,
    db: ipGetFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
  setHostDatabaseRules(ctx, undefined, initialRules);
  cleanups.push(() => {
    sandbox.dispose();
  });

  const openClient = async (label: string) => {
    const { clientPort, hostPort } = makePortPair();
    const hostPortLike: PortLike = {
      postMessage: (msg: OutboundMessage) => hostPort.postMessage(msg),
    };
    hostPort.onmessage = (event) => {
      void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const raw = workerSurface.getFirestore(`worker://stdlib-${label}-${Math.random()}`);
    const db = workerSurface.rtdbGetDatabase(raw);
    return { raw, db };
  };

  const openRemote = async () => {
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
                clientSessionId: 'served-stdlib-relay',
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
    cleanups.push(() => {
      core.dispose('closed');
    });
    return createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl: 'http://localhost:5000',
      close: () => core.dispose('closed'),
    });
  };

  const main = await openClient('main');
  return { mainDb: main.db, openClient, openRemote };
}

async function openNodeHostHarness(
  initialRules: { rules: Record<string, unknown> },
): Promise<ServedPlaneHarness> {
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-hosted-stdlib-'));
  const sockets = new Map<string, { send(data: string): void }>();
  const clientPorts: Array<{ close(): void }> = [];
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-hosted-stdlib-${Math.random()}`),
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
      databaseRules: initialRules,
      databaseRulesHash: null,
      storageRules: OPEN_STORAGE_RULES,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: 'oracle-hosted-stdlib',
      sessionToken: 'tok-hosted-stdlib',
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
      if (typeof sessionId !== 'string') {
        return;
      }
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
      nextSession += 1;
      const sessionId = `hosted-stdlib-${nextSession}`;
      if (bunServer.upgrade(request, { data: { sessionId } })) {
        return undefined;
      }
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.set(socket.data.sessionId, socket);
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as BridgeMessage;
        if (message.type === 'attach') {
          socket.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: socket.data.sessionId,
              projectKey: 'oracle-hosted-stdlib',
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage),
          );
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

  cleanups.push(async () => {
    for (const port of clientPorts.splice(0)) {
      try {
        port.close();
      } catch {
        // Ignore already-closed client ports on teardown.
      }
    }
    await runtime.close();
    await server.stop(true);
    rmSync(projectDir, { recursive: true, force: true });
  });

  const openClient = async (label: string) => {
    let attached = false;
    const raw = workerSurface.getHostedFirestore({
      url: wsUrl,
      projectKey: 'oracle-hosted-stdlib',
      retryInitialConnection: false,
      onConnection: (state) => {
        if (state === 'attached') {
          attached = true;
        }
      },
    });
    clientPorts.push(raw.port);
    await waitUntil(() => attached, `hosted attach (${label})`);
    const db = workerSurface.rtdbGetDatabase(raw);
    return { raw, db };
  };

  const openRemote = async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket connect failed')), {
        once: true,
      });
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
    ws.addEventListener('message', (event) => {
      core.handleMessage(JSON.parse(String(event.data)) as BridgeMessage);
    });
    core.start();
    await core.ready;
    clientPorts.push({
      close() {
        core.dispose('closed');
        ws.close();
      },
    });
    return createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl,
      close: () => {
        core.dispose('closed');
        ws.close();
      },
    });
  };

  const main = await openClient('main');
  return { mainDb: main.db, openClient, openRemote };
}

type PlaneFactory = (initialRules: { rules: Record<string, unknown> }) => Promise<ServedPlaneHarness>;

export const SERVED_RTDB_PLANES: ReadonlyArray<[string, PlaneFactory]> = [
  ['served SharedWorker', openSharedWorkerHarness],
  ['served Node host', openNodeHostHarness],
];
