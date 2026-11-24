import 'fake-indexeddb/auto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { FirebaseOptions } from 'pyric/app';
import { createMemoryBackend } from 'pyric/sandbox';
import { recordCheckpointBackend } from 'pyric/sandbox/checkpoints';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';

export const REPO_ROOT = resolve(import.meta.dir, '../../../..');
export const PROJECT_ID = 'demo-crashlytics-web-conformance';
export const APP_ID = '1:888:web:crashlyticslive';

export const SHARED_CONFIG: FirebaseOptions = {
  apiKey: 'fake-key-live-host',
  projectId: PROJECT_ID,
  appId: APP_ID,
};

export interface CrashlyticsStateView {
  collectionEnabled: boolean;
  userId: string | null;
  customKeys: Record<string, unknown>;
  logs: Array<{ message: string; attributes?: Record<string, unknown> }>;
  reports: Array<{
    name: string;
    message: string;
    fatal: boolean;
    flushed: boolean;
    sdkPlatform: string;
    breadcrumbs: Array<{ message: string }>;
  }>;
  unsentReports: Array<{
    name: string;
    message: string;
    flushed: boolean;
  }>;
}

function makeInMemoryHostedPersistence(
  sharedBackend = createMemoryBackend(),
): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: () => {},
    listByPrefix: async () => [],
    buckets: async () => [],
    getBlob: async () => undefined,
    getMetadata: async () => undefined,
    getObject: async () => undefined,
    delete: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: sharedBackend,
    storage: storageStub,
    checkpoints: recordCheckpointBackend(createMemoryBackend()),
    state: { seed: async () => false },
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

export async function startLiveCrashlyticsHost(
  sharedBackend?: ReturnType<typeof createMemoryBackend>,
) {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const hostedRuntime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${PROJECT_ID}-default-rtdb`,
        projectId: PROJECT_ID,
        rules: {},
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: REPO_ROOT,
      permissive: true,
    },
    () => baseOrigin,
    (message) => {
      bridge.handleSandboxMessage(message);
    },
    REPO_ROOT,
    {
      persistence: makeInMemoryHostedPersistence(sharedBackend),
      record: false,
    },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      hostedRuntime.receive(inbound);
    },
    [...hostedRuntime.toolNames],
    hostedRuntime.instanceId,
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/__pyric/sandbox') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPeer(bridge, ws, false);
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  baseOrigin = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;

  return {
    wsUrl,
    hostedRuntime,
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      server.close();
      unregisterPeer();
      await hostedRuntime.close();
    },
  };
}

export async function openAttachedSocket(wsUrl: string, sessionId: string) {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', rejectOpen);
  });
  const replies = new Map<string, (frame: WorkerResFrame) => void>();
  let resolveAck = (): void => {};
  const ackPromise = new Promise<void>((resolvePromise) => {
    resolveAck = resolvePromise;
  });

  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(msg: InboundMessage) {
      if (msg.t === 'op') {
        const { t: _t, id, ...rest } = msg;
        socket.send(
          JSON.stringify({
            type: 'worker-op',
            id,
            op: rest,
          } as BridgeMessage),
        );
      }
    },
    start() {},
    close() {},
  };

  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as BridgeMessage;
    if (frame.type === 'attach-ack') {
      resolveAck();
      return;
    }
    if (frame.type === 'worker-res') {
      const waiter = replies.get(frame.id);
      if (waiter !== undefined) {
        replies.delete(frame.id);
        waiter(frame);
      }
      let resMsg: OutboundMessage;
      if (frame.ok) {
        resMsg = { t: 'res', id: frame.id, ok: true, value: frame.value };
      } else {
        resMsg = {
          t: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: frame.error?.code ?? 'internal',
            message: frame.error?.message ?? 'error',
          },
        };
      }
      clientPort.onmessage?.({ data: resMsg } as MessageEvent<OutboundMessage>);
    }
  });

  socket.send(
    JSON.stringify({
      type: 'attach',
      protocol: 1,
      clientSessionId: sessionId,
      clientInfo: { platform: 'web' },
    } satisfies BridgeMessage),
  );
  await ackPromise;
  wirePort(clientPort);

  let seq = 0;
  const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `${sessionId}-op-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply) => {
      replies.set(id, resolveReply);
      socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
    });
  };

  return {
    sendOp,
    clientDb: { __kind: 'client-db' as const, port: clientPort } as ClientDb,
    close() {
      socket.terminate();
    },
  };
}
