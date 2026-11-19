import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import { WebSocket } from 'ws';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { EmailAuthProvider } from 'pyric/auth';
import { createMemoryBackend, type Sandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, sleep, until } from '../integration-support.js';
import {
  createAnonCredExpiryAdminSession,
  replayAuthAnonymousIdempotencyAndRemint,
  replayAuthCredentialSignInRichUserAndDisabledGuard,
  replayAuthGetIdTokenExpiryBufferRefresh,
  type AuthAnonCredExpiryReplayContext,
  type ReplayAnonCredExpiryAuthSdk,
} from '../../../../../conformance/src/auth-anon-cred-expiry-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-anon-cred-expiry';
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

async function servedWorkerAnonCredExpiryContext(): Promise<AuthAnonCredExpiryReplayContext> {
  const ctx = await makeHostCtx();
  ctx.appOptions = { projectId: PROJECT_ID };
  ensureAuth(ctx);
  const clock = getClock(ctx.sandbox);
  clock.set(Date.UTC(2026, 0, 1));
  activeHostCtx = ctx;

  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: FakePort;
    addEventListener() {}
    constructor(_url: unknown, _opts: unknown) {
      const targetCtx = activeHostCtx ?? ctx;
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

  const servedAuth = await import('../../../../src/serve/entries/auth.js');
  const createdApps: FirebaseApp[] = [];
  appSeq += 1;
  const app = createAppForSandbox(
    ctx.sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-worker-ace-key' },
    `served-ace-${appSeq}`,
  );
  createdApps.push(app);
  const auth = servedAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createAnonCredExpiryAdminSession(
    ctx.sandbox,
    PROJECT_ID,
    'served-worker',
  );
  let seq = 0;

  return {
    auth,
    authSdk: servedAuth as unknown as ReplayAnonCredExpiryAuthSdk,
    adminAuth,
    FirebaseError,
    advanceClock: async (ms: number) => {
      clock.advance(ms);
    },
    settle: () => sleep(25),
    nextUid: (label) => {
      seq += 1;
      return `served-ace-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `served-ace-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      for (const candidate of createdApps) {
        try {
          await deleteApp(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
      await adminCleanup();
      ctx.sandbox.dispose();
    },
  };
}

async function nodeHostedAnonCredExpiryContext(): Promise<AuthAnonCredExpiryReplayContext> {
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
      sessionToken: 'tok-hosted-auth-ace',
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
      const sessionId = `hosted-auth-${nextSession}`;
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

  const auth = clientAuth.getAuth(clientDb);
  const { adminAuth, cleanup: adminCleanup } = createAnonCredExpiryAdminSession(
    remoteSandbox,
    PROJECT_ID,
    'node-hosted',
  );
  const methodConnection = {};
  let seq = 0;

  const hostedAuthSdk: ReplayAnonCredExpiryAuthSdk = {
    EmailAuthProvider,
    signInAnonymously: (inst) => clientAuth.signInAnonymously(inst as never) as never,
    signInWithEmailAndPassword: (inst, email, password) =>
      clientAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
    signInWithCredential: (inst, credential) =>
      clientAuth.signInWithCredential(inst as never, credential as never) as never,
    signOut: (inst) => clientAuth.signOut(inst as never),
    onAuthStateChanged: (inst, cb) => clientAuth.onAuthStateChanged(inst as never, cb as never),
    onIdTokenChanged: (inst, cb) => clientAuth.onIdTokenChanged(inst as never, cb as never),
  };

  return {
    auth: auth as never,
    authSdk: hostedAuthSdk,
    adminAuth,
    FirebaseError,
    advanceClock: async (ms: number) => {
      const outcome = await runtime.runMethod(
        {
          key: 'sandbox.advanceClock',
          args: { ms },
          projectDir,
        },
        methodConnection,
      );
      if (!outcome.ok) {
        throw new Error(`sandbox.advanceClock failed: ${outcome.summary}`);
      }
    },
    settle: () => sleep(35),
    nextUid: (label) => {
      seq += 1;
      return `hosted-ace-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `hosted-ace-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      await adminCleanup();
      core.dispose('closed');
      adminWs.close();
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

describe('Auth anonymous idempotency/remint, credential sign-in rich user/disabled guard, and token expiry buffer oracle captures (SharedWorker + Node host)', () => {
  restoreSharedWorker();

  it('SharedWorker: auth-getidtoken-expiry-buffer-refresh (auth#55a)', async () => {
    const production = load('auth-getidtoken-expiry-buffer-refresh');
    const pyric = await replayAuthGetIdTokenExpiryBufferRefresh(
      await servedWorkerAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });

  it('SharedWorker: auth-anonymous-idempotency-and-remint (auth#8, auth#9)', async () => {
    const production = load('auth-anonymous-idempotency-and-remint');
    const pyric = await replayAuthAnonymousIdempotencyAndRemint(
      await servedWorkerAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });

  it('SharedWorker: auth-credential-signin-rich-user-and-disabled-guard (auth#47a, auth#70)', async () => {
    const production = load('auth-credential-signin-rich-user-and-disabled-guard');
    const pyric = await replayAuthCredentialSignInRichUserAndDisabledGuard(
      await servedWorkerAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });

  it('Node host WebSocket: auth-getidtoken-expiry-buffer-refresh (auth#55a)', async () => {
    const production = load('auth-getidtoken-expiry-buffer-refresh');
    const pyric = await replayAuthGetIdTokenExpiryBufferRefresh(
      await nodeHostedAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });

  it('Node host WebSocket: auth-anonymous-idempotency-and-remint (auth#8, auth#9)', async () => {
    const production = load('auth-anonymous-idempotency-and-remint');
    const pyric = await replayAuthAnonymousIdempotencyAndRemint(
      await nodeHostedAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });

  it('Node host WebSocket: auth-credential-signin-rich-user-and-disabled-guard (auth#47a, auth#70)', async () => {
    const production = load('auth-credential-signin-rich-user-and-disabled-guard');
    const pyric = await replayAuthCredentialSignInRichUserAndDisabledGuard(
      await nodeHostedAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });
});
