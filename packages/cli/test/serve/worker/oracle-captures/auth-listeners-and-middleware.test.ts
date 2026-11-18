import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from '../integration-support.js';
import {
  createListenersAdminSession,
  replayAuthOnAuthStateChangedDuplicateFnAndUnsubDuringEmit,
  replayAuthOnAuthStateChangedSameUidDedupVsIdToken,
  type AuthListenersAndMiddlewareReplayContext,
  type ReplayListenersAndMiddlewareAuthSdk,
} from '../../../../../conformance/src/auth-listeners-and-middleware-replay.ts';
import { observeSyncAuthAttempt } from '../../../../../conformance/src/auth-user-probe-session.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-listeners';
let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

async function servedWorkerListenersContext(): Promise<AuthListenersAndMiddlewareReplayContext> {
  const ctx = await makeHostCtx();
  ctx.appOptions = { projectId: PROJECT_ID };
  ensureAuth(ctx);
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
  const createApp = (label: string): FirebaseApp => {
    appSeq += 1;
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: PROJECT_ID, apiKey: 'demo-worker-listeners-key' },
      `served-listeners-${label}-${appSeq}`,
    );
    createdApps.push(app);
    return app;
  };
  const primaryApp = createApp('primary');
  const auth = servedAuth.getAuth(primaryApp);
  const { adminAuth, cleanup: adminCleanup } = createListenersAdminSession(
    ctx.sandbox,
    PROJECT_ID,
    'served-worker',
  );
  let seq = 0;

  const authSdk: ReplayListenersAndMiddlewareAuthSdk = {
    inMemoryPersistence: servedAuth.inMemoryPersistence,
    initializeAuth: (app, deps) => servedAuth.initializeAuth(app as FirebaseApp, deps) as never,
    signInWithCustomToken: (inst, token) =>
      servedAuth.signInWithCustomToken(inst as never, token) as never,
    signOut: (inst) => servedAuth.signOut(inst as never),
    updateProfile: (user, profile) => servedAuth.updateProfile(user as never, profile),
    onAuthStateChanged: (inst, cb) => servedAuth.onAuthStateChanged(inst as never, cb as never),
    onIdTokenChanged: (inst, cb) => servedAuth.onIdTokenChanged(inst as never, cb as never),
    beforeAuthStateChanged: (inst, cb, onAbort) =>
      servedAuth.beforeAuthStateChanged(inst as never, cb as never, onAbort),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    FirebaseError: FirebaseError as unknown as new (...args: never[]) => Error,
    createAuxiliaryApp: (label) => createApp(label),
    nextUid: (label) => {
      seq += 1;
      return `served-listeners-${label}-${seq}`;
    },
    cleanup: async () => {
      for (const app of createdApps) {
        try {
          await deleteApp(app);
        } catch {
          // Best-effort cleanup.
        }
      }
      await adminCleanup();
      ctx.sandbox.dispose();
    },
  };
}

describe('Auth listeners and beforeAuthStateChanged oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('auth-onauthstatechanged-same-uid-dedup-vs-idtoken (auth#30a, #38a)', async () => {
    const production = load('auth-onauthstatechanged-same-uid-dedup-vs-idtoken');
    const pyric = await replayAuthOnAuthStateChangedSameUidDedupVsIdToken(
      await servedWorkerListenersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit (auth#33a, #34)', async () => {
    const production = load('auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit');
    const pyric = await replayAuthOnAuthStateChangedDuplicateFnAndUnsubDuringEmit(
      await servedWorkerListenersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('beforeAuthStateChanged refuses registration over SharedWorker per auth#76d', async () => {
    const ctx = await servedWorkerListenersContext();
    try {
      const refusal = observeSyncAuthAttempt(
        () => ctx.authSdk.beforeAuthStateChanged(ctx.auth, () => {}),
        FirebaseError as unknown as new (...args: never[]) => Error,
      );
      expect(refusal).toEqual({
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/unsupported-in-served-mode',
      });
    } finally {
      await ctx.cleanup();
    }
  });
});
