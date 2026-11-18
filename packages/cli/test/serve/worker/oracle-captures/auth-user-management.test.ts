import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from '../integration-support.js';
import {
  createUserManagementAdminSession,
  DELETE_USER_SIGNIN_ENUMERATION_PIN,
  replayAuthDeleteUserSignOutAndFollowupErrors,
  replayAuthInitializeAuthLifecycleAndDeps,
  replayAuthReloadOutOfBandAndDisabledDeleted,
  replayAuthUpdateCurrentUserSetAndNullSignOut,
  type AuthUserManagementReplayContext,
  type ReplayUserManagementAuthSdk,
} from '../../../../../conformance/src/auth-user-management-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

async function servedWorkerUserManagementContext(): Promise<AuthUserManagementReplayContext> {
  const ctx = await makeHostCtx();
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
      { projectId: 'demo-auth-user-management', apiKey: 'demo-worker-api-key' },
      `served-mgmt-${label}-${appSeq}`,
    );
    createdApps.push(app);
    return app;
  };
  const primaryApp = createApp('primary');
  const auth = servedAuth.getAuth(primaryApp);
  const { adminAuth, cleanup: adminCleanup } = createUserManagementAdminSession(
    ctx.sandbox,
    'served-worker',
  );
  let seq = 0;

  const authSdk: ReplayUserManagementAuthSdk = {
    inMemoryPersistence: servedAuth.inMemoryPersistence,
    getAuth: (app) => servedAuth.getAuth(app as FirebaseApp) as never,
    initializeAuth: (app, deps) => servedAuth.initializeAuth(app as FirebaseApp, deps) as never,
    signInWithEmailAndPassword: (inst, email, password) =>
      servedAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
    signOut: (inst) => servedAuth.signOut(inst as never),
    onAuthStateChanged: (inst, cb) => servedAuth.onAuthStateChanged(inst as never, cb as never),
    deleteUser: (user) => servedAuth.deleteUser(user as never),
    reload: (user) => servedAuth.reload(user as never),
    updateCurrentUser: (inst, user) =>
      servedAuth.updateCurrentUser(inst as never, user as never),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    FirebaseError: FirebaseError as unknown as new (...args: never[]) => Error,
    createAuxiliaryApp: (label) => createApp(label),
    nextUid: (label) => {
      seq += 1;
      return `served-mgmt-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `served-mgmt-${label}-${seq}@example.com`;
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

describe('Auth user-management and session oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('auth-initializeauth-lifecycle-and-deps (auth#82)', async () => {
    const production = load('auth-initializeauth-lifecycle-and-deps');
    const pyric = await replayAuthInitializeAuthLifecycleAndDeps(
      await servedWorkerUserManagementContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-deleteuser-signout-and-followup-errors (auth#83)', async () => {
    const production = load('auth-deleteuser-signout-and-followup-errors');
    const pyric = await replayAuthDeleteUserSignOutAndFollowupErrors(
      await servedWorkerUserManagementContext(),
    );
    expectReplay({
      production,
      pyric,
      pins: [DELETE_USER_SIGNIN_ENUMERATION_PIN],
    });
  });

  it('auth-reload-out-of-band-and-disabled-deleted (auth#86)', async () => {
    const production = load('auth-reload-out-of-band-and-disabled-deleted');
    const pyric = await replayAuthReloadOutOfBandAndDisabledDeleted(
      await servedWorkerUserManagementContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-updatecurrentuser-set-and-null-signout (auth#87)', async () => {
    const production = load('auth-updatecurrentuser-set-and-null-signout');
    const pyric = await replayAuthUpdateCurrentUserSetAndNullSignOut(
      await servedWorkerUserManagementContext(),
    );
    expectReplay({ production, pyric });
  });
});
