import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import { WebSocket } from 'ws';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { sandbox as authSandbox } from 'pyric/auth';
import { createMemoryBackend } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, sleep, until } from '../integration-support.js';
import {
  replayAuthSignInEmptyPasswordError,
  type AuthEmptyPasswordReplaySession,
} from '../../../../../conformance/src/auth-signin-empty-password-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-empty-password';
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

async function servedWorkerEmptyPasswordSession(): Promise<AuthEmptyPasswordReplaySession> {
  const ctx = await makeHostCtx();
  ctx.appOptions = { projectId: PROJECT_ID };
  const hostAuth = ensureAuth(ctx);
  installSharedWorkerForHost(ctx);

  const servedAuth = await import('../../../../src/serve/entries/auth.js');
  appSeq += 1;
  const app: FirebaseApp = createAppForSandbox(
    ctx.sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-worker-ep-key' },
    `served-ep-${appSeq}`,
  );
  const auth = servedAuth.getAuth(app);
  const existingUid = `served-ep-uid-${appSeq}`;
  const existingEmail = `served-ep-existing-${appSeq}@example.com`;
  const unknownEmail = `served-ep-unknown-${appSeq}@example.com`;
  const validPassword = 'ProbePassword!123';

  authSandbox.seedUsers(hostAuth, [
    { uid: existingUid, email: existingEmail, password: validPassword },
  ]);

  let initialAuthStateObserved = false;
  let initialIdTokenObserved = false;

  return {
    context: {
      auth: auth as never,
      firebaseErrorCtor: FirebaseError,
      unknownEmail,
      existingEmail,
      existingUid,
      validPassword,
      signInWithEmailAndPassword: (inst, email, password) =>
        servedAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
      onAuthStateChanged: (inst, cb) =>
        servedAuth.onAuthStateChanged(inst as never, ((user: unknown) => {
          initialAuthStateObserved = true;
          cb(user as never);
        }) as never),
      onIdTokenChanged: (inst, cb) =>
        servedAuth.onIdTokenChanged(inst as never, ((user: unknown) => {
          initialIdTokenObserved = true;
          cb(user as never);
        }) as never),
      settleListeners: async () => {
        await until(
          () => initialAuthStateObserved && initialIdTokenObserved,
          'initial served Auth/IdToken listener sync',
        );
        await sleep(25);
      },
    },
    cleanup: async () => {
      try {
        await deleteApp(app);
      } catch {
        // Best-effort app disposal.
      }
      ctx.sandbox.dispose();
    },
  };
}

async function nodeHostedEmptyPasswordSession(): Promise<AuthEmptyPasswordReplaySession> {
  const projectDir = process.cwd();
  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = makeInMemoryHostedPersistence();
  appSeq += 1;
  const runNum = appSeq;

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
      sessionToken: `tok-hosted-ep-${runNum}`,
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
      const sessionId = `hosted-ep-${runNum}-${nextSession}`;
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

  const openClientAuth = async (label: string) => {
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
    await until(() => attached, `hosted Auth empty-password attach (${label})`);
    return { clientDb, auth: clientAuth.getAuth(clientDb) };
  };

  const existingEmail = `hosted-ep-existing-${runNum}@example.com`;
  const unknownEmail = `hosted-ep-unknown-${runNum}@example.com`;
  const validPassword = 'ProbePassword!123';

  const seeder = await openClientAuth('seeder');
  const seededCred = await clientAuth.createUserWithEmailAndPassword(
    seeder.auth,
    existingEmail,
    validPassword,
  );
  const existingUid = seededCred.user.uid;
  await clientAuth.signOut(seeder.auth);
  seeder.clientDb.port.close();

  const subject = await openClientAuth('subject');

  let initialAuthStateObserved = false;
  let initialIdTokenObserved = false;

  return {
    context: {
      auth: subject.auth as never,
      firebaseErrorCtor: FirebaseError,
      unknownEmail,
      existingEmail,
      existingUid,
      validPassword,
      signInWithEmailAndPassword: (inst, email, password) =>
        clientAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
      onAuthStateChanged: (inst, cb) =>
        clientAuth.onAuthStateChanged(inst as never, ((user: unknown) => {
          initialAuthStateObserved = true;
          cb(user as never);
        }) as never),
      onIdTokenChanged: (inst, cb) =>
        clientAuth.onIdTokenChanged(inst as never, ((user: unknown) => {
          initialIdTokenObserved = true;
          cb(user as never);
        }) as never),
      settleListeners: async () => {
        await until(
          () => initialAuthStateObserved && initialIdTokenObserved,
          'initial hosted Auth/IdToken listener sync',
        );
        await sleep(30);
      },
    },
    cleanup: async () => {
      try {
        subject.clientDb.port.close();
      } catch {
        // Ignore already-closed port.
      }
      await runtime.close();
      await server.stop(true);
    },
  };
}

describe('Auth signInWithEmailAndPassword empty-password oracle capture (SharedWorker + Node host)', () => {
  restoreSharedWorker();

  it('SharedWorker: auth-signin-empty-password-error (auth#15a)', async () => {
    const production = load('auth-signin-empty-password-error');
    const pyric = await replayAuthSignInEmptyPasswordError(await servedWorkerEmptyPasswordSession());
    expectReplay({ production, pyric });
  });

  it('Node host WebSocket: auth-signin-empty-password-error (auth#15a)', async () => {
    const production = load('auth-signin-empty-password-error');
    const pyric = await replayAuthSignInEmptyPasswordError(await nodeHostedEmptyPasswordSession());
    expectReplay({ production, pyric });
  });
});
