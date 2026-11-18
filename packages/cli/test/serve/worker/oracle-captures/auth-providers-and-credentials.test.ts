import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from '../integration-support.js';
import {
  createProvidersAdminSession,
  replayAuthCredentialFactoriesAndJsonRoundtrip,
  replayAuthEmailCredentialSigninAndProviderdata,
  replayAuthProviderClassesAndSamlGuard,
  type AuthProvidersAndCredentialsReplayContext,
  type ReplayProvidersAndCredentialsAuthSdk,
} from '../../../../../conformance/src/auth-providers-and-credentials-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

const PROJECT_ID = 'demo-auth-providers';
let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

async function servedWorkerProvidersContext(): Promise<AuthProvidersAndCredentialsReplayContext> {
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
  appSeq += 1;
  const app: FirebaseApp = createAppForSandbox(
    ctx.sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-worker-providers-key' },
    `served-providers-${appSeq}`,
  );
  const auth = servedAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createProvidersAdminSession(
    ctx.sandbox,
    PROJECT_ID,
    'served-worker',
  );
  let seq = 0;

  return {
    auth,
    authSdk: servedAuth as unknown as ReplayProvidersAndCredentialsAuthSdk,
    adminAuth,
    FirebaseError,
    nextUid: (label) => {
      seq += 1;
      return `served-prov-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `served-prov-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      try {
        await deleteApp(app);
      } catch {
        // Best-effort cleanup.
      }
      await adminCleanup();
      ctx.sandbox.dispose();
    },
  };
}

describe('Auth provider classes, credentials, and providerData oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('auth-provider-classes-and-saml-guard (auth#50, #52, #181)', async () => {
    const production = load('auth-provider-classes-and-saml-guard');
    const pyric = await replayAuthProviderClassesAndSamlGuard(
      await servedWorkerProvidersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-credential-factories-and-json-roundtrip (auth#51, #180, #181)', async () => {
    const production = load('auth-credential-factories-and-json-roundtrip');
    const pyric = await replayAuthCredentialFactoriesAndJsonRoundtrip(
      await servedWorkerProvidersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-email-credential-signin-and-providerdata (auth#180, #182)', async () => {
    const production = load('auth-email-credential-signin-and-providerdata');
    const pyric = await replayAuthEmailCredentialSigninAndProviderdata(
      await servedWorkerProvidersContext(),
    );
    expectReplay({ production, pyric });
  });
});
