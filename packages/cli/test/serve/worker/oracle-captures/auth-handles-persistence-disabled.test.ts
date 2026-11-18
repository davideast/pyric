import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from '../integration-support.js';
import {
  createHandlesAdminSession,
  replayAuthDisabledAccountSignInAndRefresh,
  replayAuthHandleCachingLiveCurrentUserAndReSignIn,
  replayAuthSetPersistenceAndFirebaseErrorWrapper,
  type AuthHandlesPersistenceDisabledReplayContext,
  type ReplayHandlesPersistenceDisabledAuthSdk,
} from '../../../../../conformance/src/auth-handles-persistence-disabled-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-handles';
let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

async function servedWorkerHandlesContext(): Promise<AuthHandlesPersistenceDisabledReplayContext> {
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
  const makeApp = (label: string): FirebaseApp => {
    appSeq += 1;
    const nextApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: PROJECT_ID, apiKey: 'demo-worker-handles-key' },
      `served-handles-${label}-${appSeq}`,
    );
    createdApps.push(nextApp);
    return nextApp;
  };
  const app = makeApp('primary');
  const auth = servedAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createHandlesAdminSession(
    ctx.sandbox,
    PROJECT_ID,
    'served-worker',
  );
  let seq = 0;

  return {
    auth,
    authSdk: servedAuth as unknown as ReplayHandlesPersistenceDisabledAuthSdk,
    adminAuth,
    FirebaseError,
    createAuxiliaryClientApp: (label) => makeApp(label),
    nextUid: (label) => {
      seq += 1;
      return `served-hpd-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `served-hpd-${label}-${seq}@example.com`;
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

describe('Auth handle caching, persistence markers, FirebaseError wrapper, and disabled-account oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('auth-handle-caching-live-currentuser-and-resignin (auth#1, #5, #16, #49e)', async () => {
    const production = load('auth-handle-caching-live-currentuser-and-resignin');
    const pyric = await replayAuthHandleCachingLiveCurrentUserAndReSignIn(
      await servedWorkerHandlesContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-setpersistence-and-firebaseerror-wrapper (auth#41, #42, #49f)', async () => {
    const production = load('auth-setpersistence-and-firebaseerror-wrapper');
    const pyric = await replayAuthSetPersistenceAndFirebaseErrorWrapper(
      await servedWorkerHandlesContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-disabled-account-signin-and-refresh (auth#69)', async () => {
    const production = load('auth-disabled-account-signin-and-refresh');
    const pyric = await replayAuthDisabledAccountSignInAndRefresh(
      await servedWorkerHandlesContext(),
    );
    expectReplay({ production, pyric });
  });
});
