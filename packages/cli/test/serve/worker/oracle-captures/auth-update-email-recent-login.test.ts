import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { WebSocket } from 'ws';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { EmailAuthProvider } from 'pyric/auth';
import { createMemoryBackend, getClock } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientActionCodes from '../../../../src/serve/worker/client/auth-action-codes.js';
import * as clientLinking from '../../../../src/serve/worker/client/auth-linking.js';
import * as clientReauth from '../../../../src/serve/worker/client/auth-reauthentication.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, until } from '../integration-support.js';
import {
  buildAuthUpdateEmailDivergencePin,
  replayAuthRequiresRecentLoginAndUpdateEmail,
  type AuthUpdateEmailRecentLoginFactory,
  type AuthUpdateEmailRecentLoginSession,
  type ReplayRecentLoginAuthSdk,
} from '../../../../../conformance/src/auth-update-email-recent-login-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-update-email';
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

function servedWorkerUpdateEmailFactory(): AuthUpdateEmailRecentLoginFactory {
  let emailSeq = 0;
  return {
    nextEmail(label: string): string {
      emailSeq += 1;
      return `served-ue-${label}-${emailSeq}@example.com`;
    },
    async openSession(label: string): Promise<AuthUpdateEmailRecentLoginSession> {
      const ctx = await makeHostCtx();
      ctx.appOptions = { projectId: PROJECT_ID };
      ensureAuth(ctx);
      installSharedWorkerForHost(ctx);

      const servedAuth = await import('../../../../src/serve/entries/auth.js');
      appSeq += 1;
      const app: FirebaseApp = createAppForSandbox(
        ctx.sandbox,
        { projectId: PROJECT_ID, apiKey: 'demo-worker-ue-key' },
        `served-ue-${label}-${appSeq}`,
      );
      const auth = servedAuth.getAuth(app);
      const authSdk: ReplayRecentLoginAuthSdk = {
        createEmailCredential: (email, password) =>
          servedAuth.EmailAuthProvider.credential(email, password),
        createUserWithEmailAndPassword: (inst, email, password) =>
          servedAuth.createUserWithEmailAndPassword(inst as never, email, password) as never,
        signInWithEmailAndPassword: (inst, email, password) =>
          servedAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
        signInAnonymously: (inst) => servedAuth.signInAnonymously(inst as never) as never,
        signOut: (inst) => servedAuth.signOut(inst as never),
        updateProfile: (user, profile) => servedAuth.updateProfile(user as never, profile),
        updateEmail: (user, newEmail) => servedAuth.updateEmail(user as never, newEmail),
        updatePassword: (user, newPassword) =>
          servedAuth.updatePassword(user as never, newPassword),
        verifyBeforeUpdateEmail: (user, newEmail) =>
          servedAuth.verifyBeforeUpdateEmail(user as never, newEmail),
        deleteUser: (user) => servedAuth.deleteUser(user as never),
        linkWithCredential: (user, credential) =>
          servedAuth.linkWithCredential(user as never, credential as never) as never,
        unlink: (user, providerId) => servedAuth.unlink(user as never, providerId) as never,
        reauthenticateWithCredential: (user, credential) =>
          servedAuth.reauthenticateWithCredential(user as never, credential as never) as never,
      };
      return {
        auth: auth as never,
        authSdk,
        advanceClock: async (ms: number) => {
          getClock(ctx.sandbox).advance(ms);
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
    },
  };
}

function nodeHostedUpdateEmailFactory(): AuthUpdateEmailRecentLoginFactory {
  let emailSeq = 0;
  return {
    nextEmail(label: string): string {
      emailSeq += 1;
      return `hosted-ue-${label}-${emailSeq}@example.com`;
    },
    async openSession(label: string): Promise<AuthUpdateEmailRecentLoginSession> {
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
          sessionToken: `tok-hosted-ue-${label}`,
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
          const sessionId = `hosted-ue-${label}-${nextSession}`;
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
      await until(() => attached, `hosted Auth updateEmail attach (${label})`);

      const auth = clientAuth.getAuth(clientDb);
      const methodConnection = {};
      const authSdk: ReplayRecentLoginAuthSdk = {
        createEmailCredential: (email, password) => EmailAuthProvider.credential(email, password),
        createUserWithEmailAndPassword: (inst, email, password) =>
          clientAuth.createUserWithEmailAndPassword(inst as never, email, password) as never,
        signInWithEmailAndPassword: (inst, email, password) =>
          clientAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
        signInAnonymously: (inst) => clientAuth.signInAnonymously(inst as never) as never,
        signOut: (inst) => clientAuth.signOut(inst as never),
        updateProfile: (user, profile) => clientAuth.updateProfile(user as never, profile),
        updateEmail: (user, newEmail) => clientAuth.updateEmail(user as never, newEmail),
        updatePassword: (user, newPassword) =>
          clientAuth.updatePassword(user as never, newPassword),
        verifyBeforeUpdateEmail: (user, newEmail) =>
          clientActionCodes.verifyBeforeUpdateEmail(user as never, newEmail),
        deleteUser: (user) => clientAuth.deleteUser(user as never),
        linkWithCredential: (user, credential) =>
          clientLinking.linkWithCredential(user as never, credential as never) as never,
        unlink: (user, providerId) => clientLinking.unlink(user as never, providerId) as never,
        reauthenticateWithCredential: (user, credential) =>
          clientReauth.reauthenticateWithCredential(user as never, credential as never) as never,
      };
      return {
        auth: auth as never,
        authSdk,
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
    },
  };
}

describe('Auth updateEmail and requires-recent-login oracle capture (SharedWorker + Node host)', () => {
  restoreSharedWorker();

  it('SharedWorker: auth-requires-recent-login gated.updateEmail divergence and email lifecycle (auth#84)', async () => {
    const production = load('auth-requires-recent-login');
    const { pyric, updateEmailLifecycle } = await replayAuthRequiresRecentLoginAndUpdateEmail(
      servedWorkerUpdateEmailFactory(),
      production,
    );
    expectReplay({
      production,
      pyric,
      pins: [buildAuthUpdateEmailDivergencePin(production)],
    });
    expect(updateEmailLifecycle).toEqual({
      freshChangedEmailInPlace: true,
      oldEmailSignInCode: 'auth/invalid-credential',
      newEmailSignedInSameUid: true,
      invalidEmailCode: 'auth/invalid-email',
      duplicateEmailCode: 'auth/email-already-in-use',
      stalePreservedPreviousEmail: true,
      afterReauthUpdateEmailCode: null,
      afterReauthEmailUpdated: true,
    });
  });

  it('Node host WebSocket: auth-requires-recent-login gated.updateEmail divergence and email lifecycle (auth#84)', async () => {
    const production = load('auth-requires-recent-login');
    const { pyric, updateEmailLifecycle } = await replayAuthRequiresRecentLoginAndUpdateEmail(
      nodeHostedUpdateEmailFactory(),
      production,
    );
    expectReplay({
      production,
      pyric,
      pins: [buildAuthUpdateEmailDivergencePin(production)],
    });
    expect(updateEmailLifecycle).toEqual({
      freshChangedEmailInPlace: true,
      oldEmailSignInCode: 'auth/invalid-credential',
      newEmailSignedInSameUid: true,
      invalidEmailCode: 'auth/invalid-email',
      duplicateEmailCode: 'auth/email-already-in-use',
      stalePreservedPreviousEmail: true,
      afterReauthUpdateEmailCode: null,
      afterReauthEmailUpdated: true,
    });
  });
});
