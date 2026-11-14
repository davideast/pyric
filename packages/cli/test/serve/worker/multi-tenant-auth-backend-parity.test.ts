/**
 * Standing `BACKEND-PARITY` matrix for multi-tenant Authentication across all
 * three planes:
 *   1. `in-process` (`pyric/auth` on `LocalSandbox`)
 *   2. `node` (Hosted Node runtime `createHostedRuntime` + `ClientAuth`)
 *   3. `worker` (SharedWorker host `handleMessage` + `ClientAuth`)
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  confirmPasswordReset,
  getAuth,
  sandbox as authSandbox,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  updateCurrentUser,
} from 'pyric/auth';
import { mintCustomTokenFor } from 'pyric/auth/internal';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import {
  acceptProviderCredential,
  adminCreateUser as clientAdminCreateUser,
  getAuth as getClientAuth,
  listUsers as clientListUsers,
  sendSignInLinkToEmail as clientSendSignInLinkToEmail,
  signInWithCredential as clientSignInWithCredential,
  signInWithEmailAndPassword as clientSignInWithEmailAndPassword,
  signInWithEmailLink as clientSignInWithEmailLink,
  stageSignInResult,
  takeAuthMail as clientTakeAuthMail,
  updateCurrentUser as clientUpdateCurrentUser,
  type ClientDb,
} from '../../../src/serve/worker/client.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { makeInMemoryPersistence } from '../../bridge/five-surface-parity-harness.js';

function createWorkerHarness() {
  const sandbox = initializeSandbox({ projectId: 'org-alpha' });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    flushPersistence: async () => {},
    instanceId: 'worker-parity-test',
    subs: new Map(),
    messagingEnabled: true,
    appOptions: { projectId: 'org-alpha' },
  };
  const makeClient = (_label: string) => {
    let clientPort!: ClientPort;
    const hostPort: PortLike = {
      postMessage(msg: OutboundMessage) {
        clientPort.onmessage?.({ data: msg } as MessageEvent<OutboundMessage>);
      },
    };
    clientPort = {
      onmessage: null,
      postMessage(msg: InboundMessage) {
        void handleMessage(ctx, hostPort, msg);
      },
      start() {},
      close() {},
    };
    wirePort(clientPort);
    const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
    return { auth: getClientAuth(clientDb), clientPort };
  };
  return {
    makeClient,
    adminCreate: async (req: Record<string, unknown>) => {
      authSandbox.createUser(
        getAuth(sandbox),
        req as Parameters<typeof authSandbox.createUser>[1],
      );
    },
    close: async () => {
      sandbox.dispose();
    },
  };
}

async function createNodeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-node-auth-parity-'));
  const portsBySession = new Map<string, ClientPort>();
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      permissive: true,
      projectKey: 'org-alpha',
      sessionToken: 'tok-node-parity',
    },
    'http://127.0.0.1:4199',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-message-result') {
        const target = portsBySession.get(frame.clientSessionId);
        target?.onmessage?.({ data: frame.message } as MessageEvent<OutboundMessage>);
      }
    },
    dir,
    { persistence: makeInMemoryPersistence() as never, record: false },
  );

  const makeClient = (label: string) => {
    const clientPort: ClientPort = {
      onmessage: null,
      postMessage(msg: InboundMessage) {
        runtime.receive({ type: 'worker-message', clientSessionId: label, message: msg });
      },
      start() {},
      close() {},
    };
    portsBySession.set(label, clientPort);
    wirePort(clientPort);
    const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
    return { auth: getClientAuth(clientDb), clientPort };
  };

  const adminPort = makeClient('admin');
  return {
    makeClient,
    adminCreate: async (req: Record<string, unknown>) => {
      await clientAdminCreateUser(
        adminPort.auth,
        req as Parameters<typeof clientAdminCreateUser>[1],
      );
    },
    close: async () => {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('multi-tenant Auth BACKEND-PARITY across in-process, node, and worker planes', () => {
  it('authenticates duplicate emails independently across tenants and the project pool on all 3 planes', async () => {
    const inProcSb = initializeSandbox({ projectId: 'org-alpha' });
    const worker = createWorkerHarness();
    const node = await createNodeHarness();
    try {
      const users = [
        { uid: 'root-u', email: 'shared@example.test', password: 'RootPassword123!', tenantId: null },
        { uid: 'alpha-u', email: 'shared@example.test', password: 'AlphaPassword123!', tenantId: 'org-alpha' },
        { uid: 'beta-u', email: 'shared@example.test', password: 'BetaPassword456!', tenantId: 'org-beta' },
      ];

      // 1. In-process plane
      const inProcAuth = getAuth(inProcSb);
      for (const u of users) {
        authSandbox.createUser(inProcAuth, u as Parameters<typeof authSandbox.createUser>[1]);
      }
      expect(
        (await signInWithEmailAndPassword(inProcAuth, 'shared@example.test', 'RootPassword123!')).user.uid,
      ).toBe('root-u');
      inProcAuth.tenantId = 'org-alpha';
      expect(
        (await signInWithEmailAndPassword(inProcAuth, 'shared@example.test', 'AlphaPassword123!')).user.uid,
      ).toBe('alpha-u');
      inProcAuth.tenantId = 'org-beta';
      const inProcBeta = await signInWithEmailAndPassword(
        inProcAuth,
        'shared@example.test',
        'BetaPassword456!',
      );
      expect(inProcBeta.user.uid).toBe('beta-u');
      expect(inProcBeta.user.tenantId).toBe('org-beta');
      await expect(
        signInWithEmailAndPassword(inProcAuth, 'shared@example.test', 'AlphaPassword123!'),
      ).rejects.toMatchObject({ code: 'auth/wrong-password' });

      // 2 & 3. Hosted Node and SharedWorker planes
      for (const served of [node, worker]) {
        for (const u of users) {
          await served.adminCreate(u);
        }
        const cRoot = served.makeClient('root').auth;
        const cAlpha = served.makeClient('alpha').auth;
        cAlpha.tenantId = 'org-alpha';
        const cBeta = served.makeClient('beta').auth;
        cBeta.tenantId = 'org-beta';

        expect(
          (await clientSignInWithEmailAndPassword(cRoot, 'shared@example.test', 'RootPassword123!')).user.uid,
        ).toBe('root-u');
        expect(
          (await clientSignInWithEmailAndPassword(cAlpha, 'shared@example.test', 'AlphaPassword123!')).user.uid,
        ).toBe('alpha-u');
        const betaCred = await clientSignInWithEmailAndPassword(
          cBeta,
          'shared@example.test',
          'BetaPassword456!',
        );
        expect(betaCred.user.uid).toBe('beta-u');
        expect(betaCred.user.tenantId).toBe('org-beta');
        await expect(
          clientSignInWithEmailAndPassword(cBeta, 'shared@example.test', 'AlphaPassword123!'),
        ).rejects.toMatchObject({ code: 'auth/wrong-password' });
      }
    } finally {
      inProcSb.dispose();
      await worker.close();
      await node.close();
    }
  });

  it('refuses cross-tenant uid OAuth, credential, and custom-token sign-in without mutating the target tenant user across all 3 planes', async () => {
    const inProcSb = initializeSandbox({ projectId: 'org-alpha' });
    const worker = createWorkerHarness();
    const node = await createNodeHarness();
    try {
      const betaSeed = {
        uid: 'u-beta',
        email: 'owner@org-beta.example',
        displayName: 'Original Beta Name',
        password: 'BetaPassword123!',
        tenantId: 'org-beta',
      };

      // 1. In-process plane
      const auth = getAuth(inProcSb);
      authSandbox.createUser(auth, betaSeed as Parameters<typeof authSandbox.createUser>[1]);
      auth.tenantId = 'org-alpha';
      authSandbox.mockSignInResult(
        auth,
        {
          user: {
            uid: 'u-beta',
            email: 'hijacked@org-alpha.example',
            displayName: 'Clobbered Name',
            emailVerified: true,
          },
          providerId: 'google.com',
        } as unknown as Parameters<typeof authSandbox.mockSignInResult>[1],
      );
      await expect(
        signInWithCredential(auth, GoogleAuthProvider.credential('tok-cross')),
      ).rejects.toMatchObject({ code: 'auth/tenant-id-mismatch' });

      const token = mintCustomTokenFor(auth, 'u-beta');
      await expect(signInWithCustomToken(auth, token)).rejects.toMatchObject({
        code: 'auth/tenant-id-mismatch',
      });

      auth.tenantId = 'org-beta';
      const inProcBetaSignedIn = await signInWithEmailAndPassword(
        auth,
        'owner@org-beta.example',
        'BetaPassword123!',
      );
      const inProcAlphaOther = getAuth(inProcSb);
      inProcAlphaOther.tenantId = 'org-alpha';
      await expect(
        updateCurrentUser(inProcAlphaOther, inProcBetaSignedIn.user),
      ).rejects.toMatchObject({ code: 'auth/tenant-id-mismatch' });

      const preservedInProc = authSandbox.listUsers(auth).find((u) => u.uid === 'u-beta');
      expect(preservedInProc).toMatchObject({
        email: 'owner@org-beta.example',
        displayName: 'Original Beta Name',
        tenantId: 'org-beta',
      });

      // 2 & 3. Hosted Node and SharedWorker planes (acceptIdentity + staged signInWithCredential + updateCurrentUser)
      for (const served of [node, worker]) {
        await served.adminCreate(betaSeed);
        const betaClient = served.makeClient('beta-owner');
        betaClient.auth.tenantId = 'org-beta';
        const servedBetaSignedIn = await clientSignInWithEmailAndPassword(
          betaClient.auth,
          'owner@org-beta.example',
          'BetaPassword123!',
        );

        const alphaClient = served.makeClient('alpha-attacker');
        alphaClient.auth.tenantId = 'org-alpha';

        await expect(
          clientUpdateCurrentUser(alphaClient.auth, servedBetaSignedIn.user),
        ).rejects.toMatchObject({ code: 'auth/tenant-id-mismatch' });
        expect(alphaClient.auth.currentUser).toBeNull();

        await expect(
          acceptProviderCredential(alphaClient.auth, {
            uid: 'u-beta',
            email: 'hijacked@org-alpha.example',
            displayName: 'Clobbered From Alpha',
            photoURL: null,
            customClaims: {},
            providerId: 'google.com',
          }),
        ).rejects.toMatchObject({ code: 'auth/tenant-id-mismatch' });

        await stageSignInResult(alphaClient.auth, {
          providerId: 'google.com',
          user: {
            uid: 'u-beta',
            email: 'hijacked2@org-alpha.example',
            displayName: 'Clobbered Staged',
            photoURL: null,
          },
        } as Parameters<typeof stageSignInResult>[1]);
        await expect(
          clientSignInWithCredential(alphaClient.auth, GoogleAuthProvider.credential('tok-staged')),
        ).rejects.toMatchObject({ code: 'auth/tenant-id-mismatch' });

        const users = await clientListUsers(alphaClient.auth);
        expect(users.find((u) => u.uid === 'u-beta')).toMatchObject({
          uid: 'u-beta',
          email: 'owner@org-beta.example',
          displayName: 'Original Beta Name',
          tenantId: 'org-beta',
        });
      }
    } finally {
      inProcSb.dispose();
      await worker.close();
      await node.close();
    }
  });

  it('stores and preserves tenantId on email-link sign-in and password reset across all 3 planes', async () => {
    const inProcSb = initializeSandbox({ projectId: 'org-alpha' });
    const worker = createWorkerHarness();
    const node = await createNodeHarness();
    try {
      // 1. In-process plane
      const inProcAuth = getAuth(inProcSb);
      inProcAuth.tenantId = 'org-alpha';
      await sendSignInLinkToEmail(inProcAuth, 'link1@example.test', {
        url: 'http://localhost/finish',
        handleCodeInApp: true,
      });
      const mail1 = authSandbox.takeAuthMail(inProcAuth, 'link1@example.test')!;
      expect((await signInWithEmailLink(inProcAuth, 'link1@example.test', mail1.link)).user.tenantId).toBe(
        'org-alpha',
      );

      await sendSignInLinkToEmail(inProcAuth, 'link2@example.test', {
        url: 'http://localhost/finish',
        handleCodeInApp: true,
      });
      const mail2 = authSandbox.takeAuthMail(inProcAuth, 'link2@example.test')!;
      expect(
        (
          await signInWithCredential(
            inProcAuth,
            EmailAuthProvider.credentialWithLink('link2@example.test', mail2.link),
          )
        ).user.tenantId,
      ).toBe('org-alpha');

      for (const email of ['link1@example.test', 'link2@example.test']) {
        expect(authSandbox.listUsers(inProcAuth).find((u) => u.email === email)?.tenantId).toBe(
          'org-alpha',
        );
      }

      // 2 & 3. Hosted Node and SharedWorker planes (signInWithEmailLink + EmailAuthProvider.credentialWithLink)
      for (const served of [node, worker]) {
        const cAlpha = served.makeClient('alpha-link');
        cAlpha.auth.tenantId = 'org-alpha';

        await clientSendSignInLinkToEmail(cAlpha.auth, 'slink1@example.test', {
          url: 'http://localhost/finish',
          handleCodeInApp: true,
        });
        const sMail1 = (await clientTakeAuthMail(cAlpha.auth, 'slink1@example.test'))!;
        const sCred1 = await clientSignInWithEmailLink(cAlpha.auth, 'slink1@example.test', sMail1.link);
        expect(sCred1.user.tenantId).toBe('org-alpha');

        await clientSendSignInLinkToEmail(cAlpha.auth, 'slink2@example.test', {
          url: 'http://localhost/finish',
          handleCodeInApp: true,
        });
        const sMail2 = (await clientTakeAuthMail(cAlpha.auth, 'slink2@example.test'))!;
        const sCred2 = await clientSignInWithCredential(
          cAlpha.auth,
          EmailAuthProvider.credentialWithLink('slink2@example.test', sMail2.link),
        );
        expect(sCred2.user.tenantId).toBe('org-alpha');

        const storedUsers = await clientListUsers(cAlpha.auth);
        expect(storedUsers.find((u) => u.email === 'slink1@example.test')?.tenantId).toBe('org-alpha');
        expect(storedUsers.find((u) => u.email === 'slink2@example.test')?.tenantId).toBe('org-alpha');
      }

      // Tenant-scoped password reset isolation when duplicate emails exist across tenants
      const resetAuth = getAuth(inProcSb);
      authSandbox.createUser(resetAuth, {
        uid: 'reset-alpha',
        email: 'reset@example.test',
        password: 'OldAlphaPassword1!',
        tenantId: 'org-alpha',
      } as Parameters<typeof authSandbox.createUser>[1]);
      authSandbox.createUser(resetAuth, {
        uid: 'reset-beta',
        email: 'reset@example.test',
        password: 'OldBetaPassword2!',
        tenantId: 'org-beta',
      } as Parameters<typeof authSandbox.createUser>[1]);
      resetAuth.tenantId = 'org-beta';
      await sendPasswordResetEmail(resetAuth, 'reset@example.test');
      const resetMail = authSandbox.takeAuthMail(resetAuth, 'reset@example.test')!;
      await confirmPasswordReset(resetAuth, resetMail.code, 'NewBetaPassword3!');
      expect(
        (await signInWithEmailAndPassword(resetAuth, 'reset@example.test', 'NewBetaPassword3!')).user.uid,
      ).toBe('reset-beta');
      resetAuth.tenantId = 'org-alpha';
      expect(
        (await signInWithEmailAndPassword(resetAuth, 'reset@example.test', 'OldAlphaPassword1!')).user.uid,
      ).toBe('reset-alpha');
    } finally {
      inProcSb.dispose();
      await worker.close();
      await node.close();
    }
  });
});
