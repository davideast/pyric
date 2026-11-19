import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { deleteApp as deleteCanonicalApp, initializeApp as initializeCanonicalApp } from 'firebase/app';
import { WebSocket } from 'ws';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { createMemoryBackend } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, until } from '../integration-support.js';
import {
  replayAuthCanonicalImportAndCreateUserShape,
  type AuthCanonicalImportCreateUserReplayContext,
  type ReplayCreateUserAuthSdk,
} from '../../../../../conformance/src/auth-canonical-import-createuser-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-canonical-createuser';
let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
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

function installSharedWorkerForHost(ctx: HostCtx): void {
  activeHostCtx = ctx;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: FakePort;
    addEventListener() {}
    constructor(_url: unknown, _opts: unknown) {
      let targetCtx = ctx;
      if (activeHostCtx !== null) {
        targetCtx = activeHostCtx;
      }
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = {
        postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
      };
      hostPort.onmessage = (event) => {
        void handleMessage(targetCtx, hostPortLike, event.data as InboundMessage);
      };
      this.port = clientPort;
    }
  };
}

async function servedWorkerCanonicalCreateUserContext(): Promise<AuthCanonicalImportCreateUserReplayContext> {
  const ctx = await makeHostCtx();
  ctx.appOptions = { projectId: PROJECT_ID };
  ensureAuth(ctx);
  installSharedWorkerForHost(ctx);

  const servedAuth = await import('../../../../src/serve/entries/auth.js');
  const createdApps: FirebaseApp[] = [];
  appSeq += 1;
  const app = createAppForSandbox(
    ctx.sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-worker-cic-key' },
    `served-cic-${appSeq}`,
  );
  createdApps.push(app);
  const auth = servedAuth.getAuth(app);
  let seq = 0;

  return {
    auth,
    authSdk: servedAuth as unknown as ReplayCreateUserAuthSdk,
    nextEmail: (label) => {
      seq += 1;
      return `served-cic-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      for (const candidate of createdApps) {
        try {
          await deleteApp(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
      ctx.sandbox.dispose();
    },
  };
}

async function nodeHostedCanonicalCreateUserContext(): Promise<AuthCanonicalImportCreateUserReplayContext> {
  const projectDir = process.cwd();
  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: PROJECT_ID,
      sessionToken: 'tok-hosted-auth-cic',
      appOptions: { projectId: PROJECT_ID },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const forwardsToSocket =
        frame.type === 'worker-message-result' ||
        frame.type === 'worker-res' ||
        frame.type === 'worker-snap';
      if (!forwardsToSocket) {
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
      const sessionId = `hosted-auth-cic-${nextSession}`;
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
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  let attached = false;
  const clientDb = getHostedFirestore({
    url: wsUrl,
    projectKey: PROJECT_ID,
    retryInitialConnection: false,
    onConnection: (state) => {
      if (state === 'attached') {
        attached = true;
      }
    },
  });
  await until(() => attached, 'hosted Auth client attach');

  const auth = clientAuth.getAuth(clientDb);
  let seq = 0;

  const hostedAuthSdk: ReplayCreateUserAuthSdk = {
    createUserWithEmailAndPassword: (inst, email, password) =>
      clientAuth.createUserWithEmailAndPassword(inst as never, email, password) as never,
  };

  return {
    auth: auth as never,
    authSdk: hostedAuthSdk,
    nextEmail: (label) => {
      seq += 1;
      return `hosted-cic-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      try {
        clientDb.port.close();
      } catch {
        // Ignore already-closed port.
      }
      await runtime.close();
      await server.stop(true);
    },
  };
}

describe('Auth canonical import boundary and createUserWithEmailAndPassword shape oracle capture (SharedWorker + Node host)', () => {
  restoreSharedWorker();

  it('SharedWorker: auth-canonical-import-and-createuser-shape (auth#3, auth#20, auth#23)', async () => {
    const production = load('auth-canonical-import-and-createuser-shape');
    const pyric = await replayAuthCanonicalImportAndCreateUserShape(
      await servedWorkerCanonicalCreateUserContext(),
    );
    expectReplay({ production, pyric });
  });

  it('SharedWorker: served entries/auth rejects unswapped canonical firebase/app handles (auth#3)', async () => {
    const ctx = await makeHostCtx();
    ctx.appOptions = { projectId: PROJECT_ID };
    ensureAuth(ctx);
    installSharedWorkerForHost(ctx);
    const servedAuth = await import('../../../../src/serve/entries/auth.js');

    appSeq += 1;
    const canonicalApp = initializeCanonicalApp(
      {
        apiKey: 'AIzaSyDummyServedBoundaryKey0000000000',
        authDomain: 'demo-served-boundary.firebaseapp.com',
        projectId: 'demo-served-boundary',
        appId: '1:0:web:0',
      },
      `served-boundary-${appSeq}`,
    );
    try {
      expect(() => servedAuth.getAuth(canonicalApp as never)).toThrow(TypeError);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });
    } finally {
      await deleteCanonicalApp(canonicalApp).catch(() => undefined);
      ctx.sandbox.dispose();
    }
  });

  it('Node host WebSocket: auth-canonical-import-and-createuser-shape (auth#3, auth#20, auth#23)', async () => {
    const production = load('auth-canonical-import-and-createuser-shape');
    const pyric = await replayAuthCanonicalImportAndCreateUserShape(
      await nodeHostedCanonicalCreateUserContext(),
    );
    expectReplay({ production, pyric });
  });
});
