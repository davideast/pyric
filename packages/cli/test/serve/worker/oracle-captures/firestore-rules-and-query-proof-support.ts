import 'fake-indexeddb/auto';
import { WebSocket } from 'ws';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { getFirestore as getAdminFirestore } from 'pyric-admin/firestore';
import { getFirestore as getInPageFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import type { ClientDb } from '../../../../src/serve/worker/client/handles.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import * as workerClient from '../../../../src/serve/worker/index.js';
import { portPair, until } from '../integration-support.js';

export type ServedPlaneKind = 'SharedWorker' | 'Node host';

export interface ServedRulesReplaySession {
  readonly worker: typeof workerClient;
  openClient(authSpec?: { readonly uid: string; readonly claims?: Record<string, unknown> }): Promise<ClientDb>;
  cleanup(): Promise<void>;
}

const PROJECT_ID = 'demo-served-rules-replay';
let sessionCounter = 0;

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    listByPrefix: async () => [],
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

export async function createServedRulesReplaySession(
  plane: ServedPlaneKind,
  fullRules: string,
  seeds: Record<string, Record<string, unknown>>,
): Promise<ServedRulesReplaySession> {
  sessionCounter += 1;
  const tag = `${plane.replace(/\s+/g, '-')}-${sessionCounter}-${Math.random().toString(36).slice(2, 7)}`;

  if (plane === 'SharedWorker') {
    const sandbox = initializeSandbox({ projectId: PROJECT_ID });
    setRules(sandbox, fullRules);
    seedDocuments(sandbox, seeds);

    const ctx: HostCtx = {
      sandbox,
      db: getInPageFirestore(sandbox),
      instanceId: `sw-rules-${tag}`,
      subs: new Map(),
      flushPersistence: async () => {},
      appOptions: { projectId: PROJECT_ID },
    };
    ensureAuth(ctx);

    const adminApp = initializeAdminApp({ sandbox, projectId: PROJECT_ID }, `admin-sw-${tag}`);
    const adminAuth = getAdminAuth(adminApp);
    const openedPorts: Array<{ close(): void }> = [];

    return {
      worker: workerClient,
      async openClient(authSpec) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
          port = clientPort;
          constructor(_url: unknown, _opts: unknown) {}
        };
        const db = workerClient.getFirestore(`worker://rules-${tag}-${openedPorts.length}`);
        openedPorts.push(db.port);
        db.port.postMessage({
          t: 'appConfig',
          options: { projectId: PROJECT_ID },
        } satisfies InboundMessage);
        if (authSpec !== undefined) {
          const token = await adminAuth.createCustomToken(authSpec.uid, authSpec.claims);
          await clientAuth.signInWithCustomToken(clientAuth.getAuth(db), token);
        }
        return db;
      },
      async cleanup() {
        for (const p of openedPorts) {
          try {
            p.close();
          } catch {
            // Ignore already-closed port.
          }
        }
        await deleteAdminApp(adminApp);
        sandbox.dispose();
      },
    };
  }

  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: fullRules,
      rulesHash: `fs-${tag}`,
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: PROJECT_ID,
      sessionToken: `tok-${tag}`,
      appOptions: { projectId: PROJECT_ID },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const forwardsToSocket =
        frame.type === 'worker-message-result' ||
        frame.type === 'worker-res' ||
        frame.type === 'worker-snap';
      if (!forwardsToSocket) return;
      const sessionId = frame.clientSessionId;
      if (typeof sessionId !== 'string') return;
      const socket = sockets.get(sessionId);
      if (socket !== undefined) {
        socket.send(JSON.stringify(frame));
      }
    },
    process.cwd(),
    { persistence: persistence as never, record: false },
  );

  let nextSession = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      nextSession += 1;
      const sessionId = `hosted-rules-${tag}-${nextSession}`;
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
              projectKey: PROJECT_ID,
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
        const isRelayFrame =
          message.type === 'worker-op' ||
          message.type === 'worker-sub' ||
          message.type === 'worker-unsub';
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
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

  const adminWs = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    adminWs.once('open', () => resolve());
    adminWs.once('error', reject);
  });
  const core = createRemoteSandboxCore(
    {
      send(msg) {
        if (adminWs.readyState === WebSocket.OPEN) {
          adminWs.send(JSON.stringify(msg));
        }
      },
    },
    { serveUrl },
  );
  adminWs.on('message', (data) => {
    core.handleMessage(JSON.parse(String(data)) as BridgeMessage);
  });
  core.start();
  await core.ready;

  const remoteSandbox = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl,
    close: () => {
      core.dispose('closed');
      adminWs.close();
    },
  }) as unknown as Sandbox;

  const adminApp = initializeAdminApp({ sandbox: remoteSandbox, projectId: PROJECT_ID }, `admin-nh-${tag}`);
  const adminDb = getAdminFirestore(adminApp);
  const adminAuth = getAdminAuth(adminApp);
  for (const [docPath, data] of Object.entries(seeds)) {
    await adminDb.doc(docPath).set(data);
  }

  const openedPorts: Array<{ close(): void }> = [];
  return {
    worker: workerClient,
    async openClient(authSpec) {
      let attached = false;
      const clientDb = getHostedFirestore({
        url: wsUrl,
        projectKey: PROJECT_ID,
        retryInitialConnection: false,
        onConnection: (state) => {
          if (state === 'attached') attached = true;
        },
      });
      openedPorts.push(clientDb.port);
      await until(() => attached, `hosted rules client attach (${tag})`);
      clientDb.port.postMessage({
        t: 'appConfig',
        options: { projectId: PROJECT_ID },
      } satisfies InboundMessage);
      if (authSpec !== undefined) {
        const token = await adminAuth.createCustomToken(authSpec.uid, authSpec.claims);
        await clientAuth.signInWithCustomToken(clientAuth.getAuth(clientDb), token);
      }
      return clientDb;
    },
    async cleanup() {
      for (const p of openedPorts) {
        try {
          p.close();
        } catch {
          // Ignore already-closed port.
        }
      }
      await deleteAdminApp(adminApp);
      core.dispose('closed');
      adminWs.close();
      await runtime.close();
      await server.stop(true);
    },
  };
}
