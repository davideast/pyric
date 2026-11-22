/**
 * Cross-plane worker client + host parity tests for:
 *   - #1850: `signInWithCustomToken` refuses a sandbox ID token with `auth/invalid-custom-token`
 *   - #1699: `getAdditionalUserInfo().providerId` is `'password'` after email/password create, sign-in, and credential sign-in
 *   - #1698: linking an email credential onto an anonymous user reports `isNewUser: true` and `providerId: 'password'`
 *   - #1693: `verifyBeforeUpdateEmail` with a malformed new address answers `auth/invalid-new-email`
 *   - #1540: `ClientAuth.authStateReady()` and served in-page `auth.authStateReady()` resolve after initial auth state / restore settles
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  EmailAuthProvider,
  getAdditionalUserInfo,
  getAuth as getSandboxAuth,
  GoogleAuthProvider,
  sandbox as authSandbox,
} from 'pyric/auth';
import { setAuthBlockingHooks } from 'pyric/auth/internal';
import { customTokenSubject } from '../../../src/bridge/surface/sign-in.js';
import { createRestAuthRtdbHandler } from '../../../src/serve/rest-auth-rtdb.js';
import {
  cleanupPort,
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  restorePortSession,
  signInAnonymously,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  stageSignInResult,
  type ClientAuth,
} from '../../../src/serve/worker/client/auth.js';
import { linkWithCredential } from '../../../src/serve/worker/client/auth-linking.js';
import { reauthenticateWithCredential } from '../../../src/serve/worker/client/auth-reauthentication.js';
import {
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  takeAuthMail,
  verifyBeforeUpdateEmail,
} from '../../../src/serve/worker/client/auth-action-codes.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';

interface WorkerBridgeHarness {
  readonly sandbox: ReturnType<typeof initializeSandbox>;
  readonly ctx: HostCtx;
  readonly hostPort: PortLike;
  readonly clientAuth: ClientAuth;
  newClientAuth(): { auth: ClientAuth; hostPort: PortLike; close(): Promise<void> };
  close(): Promise<void>;
}

function createBridgeHarness(): WorkerBridgeHarness {
  const sandbox = initializeSandbox();
  getSandboxAuth(sandbox);
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    instanceId: 'auth-sdk-results-tokens-parity',
    subs: new Map(),
    flushPersistence: async () => {},
  };

  function connectPort(): { clientPort: ClientPort; hostPort: PortLike } {
    let clientPort: ClientPort | null = null;
    const hostPort: PortLike = {
      postMessage(msg: OutboundMessage) {
        clientPort?.onmessage?.({ data: msg } as MessageEvent<OutboundMessage>);
      },
    };
    const createdPort: ClientPort = {
      onmessage: null,
      postMessage(msg: InboundMessage) {
        void handleMessage(ctx, hostPort, msg);
      },
      start() {},
    };
    clientPort = createdPort;
    wirePort(createdPort);
    return { clientPort: createdPort, hostPort };
  }

  const primary = connectPort();
  const primaryDb: ClientDb = { __kind: 'client-db', port: primary.clientPort };
  const clientAuth = getClientAuth(primaryDb);

  return {
    sandbox,
    ctx,
    hostPort: primary.hostPort,
    clientAuth,
    newClientAuth() {
      const conn = connectPort();
      const db: ClientDb = { __kind: 'client-db', port: conn.clientPort };
      const auth = getClientAuth(db);
      return {
        auth,
        hostPort: conn.hostPort,
        async close() {
          await cleanupPort(ctx, conn.hostPort);
        },
      };
    },
    async close() {
      await cleanupPort(ctx, primary.hostPort);
    },
  };
}

describe('served worker parity for SDK results, error codes, and tokens', () => {
  it('refuses a sandbox ID token at signInWithCustomToken with and without blocking hooks (#1850)', async () => {
    const h = createBridgeHarness();
    try {
      const created = await createUserWithEmailAndPassword(
        h.clientAuth,
        'worker-idtok@example.com',
        'pw-123456',
      );
      const idToken = await created.user.getIdToken();
      await signOut(h.clientAuth);

      await expect(signInWithCustomToken(h.clientAuth, idToken)).rejects.toMatchObject({
        code: 'auth/invalid-custom-token',
      });
      expect(h.clientAuth.currentUser).toBeNull();
      expect(customTokenSubject(idToken)).toBeUndefined();

      // REST Identity Toolkit plane (`POST /v1/accounts:signInWithCustomToken`).
      const restHandler = createRestAuthRtdbHandler({ ctx: h.ctx });
      const bodyJson = JSON.stringify({ token: idToken, returnSecureToken: true });
      const req = Object.assign(Readable.from([Buffer.from(bodyJson, 'utf-8')]), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }) as unknown as IncomingMessage;
      let statusCode = 0;
      let responseBody = '';
      const res = {
        writeHead(status: number) {
          statusCode = status;
          return res;
        },
        end(chunk?: string | Buffer) {
          if (typeof chunk === 'string') {
            responseBody += chunk;
          } else if (Buffer.isBuffer(chunk)) {
            responseBody += chunk.toString('utf-8');
          }
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await restHandler(
        req,
        res,
        new URL('http://127.0.0.1/v1/accounts:signInWithCustomToken?key=fake-api-key'),
      );
      expect(handled).toBe(true);
      expect(statusCode).toBe(400);
      expect(JSON.parse(responseBody)).toMatchObject({
        error: { code: 400, message: 'INVALID_CUSTOM_TOKEN' },
      });

      setAuthBlockingHooks(getSandboxAuth(h.sandbox), {
        beforeCreate: async () => ({}),
        beforeSignIn: async () => ({}),
      });
      await expect(signInWithCustomToken(h.clientAuth, idToken)).rejects.toMatchObject({
        code: 'auth/invalid-custom-token',
      });
      expect(h.clientAuth.currentUser).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('populates getAdditionalUserInfo().providerId as password on create, sign-in, credential sign-in, and reauth (#1699)', async () => {
    const h = createBridgeHarness();
    try {
      const created = await createUserWithEmailAndPassword(
        h.clientAuth,
        'worker-1699@example.com',
        'pw-123456',
      );
      expect(created.providerId).toBeNull();
      expect(getAdditionalUserInfo(created as never)).toEqual({
        isNewUser: true,
        profile: {},
        providerId: 'password',
      });

      await signOut(h.clientAuth);
      const signedIn = await signInWithEmailAndPassword(
        h.clientAuth,
        'worker-1699@example.com',
        'pw-123456',
      );
      expect(signedIn.providerId).toBeNull();
      expect(getAdditionalUserInfo(signedIn as never)).toEqual({
        isNewUser: false,
        profile: {},
        providerId: 'password',
      });

      await signOut(h.clientAuth);
      const viaCred = await signInWithCredential(
        h.clientAuth,
        EmailAuthProvider.credential('worker-1699@example.com', 'pw-123456'),
      );
      expect(viaCred.providerId).toBeNull();
      expect(getAdditionalUserInfo(viaCred as never)).toEqual({
        isNewUser: false,
        profile: {},
        providerId: 'password',
      });

      const reauthed = await reauthenticateWithCredential(
        viaCred.user,
        EmailAuthProvider.credential('worker-1699@example.com', 'pw-123456'),
      );
      expect(reauthed.providerId).toBeNull();
      expect(getAdditionalUserInfo(reauthed as never)).toEqual({
        isNewUser: false,
        profile: {},
        providerId: 'password',
      });

      await signOut(h.clientAuth);
      await sendSignInLinkToEmail(h.clientAuth, 'worker-1699@example.com', {
        url: 'https://example.com/finish',
        handleCodeInApp: true,
      });
      const mail = await takeAuthMail(h.clientAuth, 'worker-1699@example.com');
      expect(mail).not.toBeNull();
      const viaLink = await signInWithEmailLink(
        h.clientAuth,
        'worker-1699@example.com',
        mail?.link ?? '',
      );
      expect(viaLink.providerId).toBeNull();
      expect(getAdditionalUserInfo(viaLink as never)).toEqual({
        isNewUser: false,
        profile: {},
        providerId: 'password',
      });
    } finally {
      await h.close();
    }
  });

  it('reports isNewUser true and providerId password when linking an email credential onto an anonymous user (#1698)', async () => {
    const h = createBridgeHarness();
    try {
      const anon = await signInAnonymously(h.clientAuth);
      expect(getAdditionalUserInfo(anon as never)).toEqual({
        isNewUser: true,
        profile: {},
        providerId: null,
      });

      const linked = await linkWithCredential(
        anon.user,
        EmailAuthProvider.credential('worker-1698@example.com', 'pw-123456'),
      );
      expect(linked.providerId).toBeNull();
      expect(linked.operationType).toBe('link');
      expect(linked.user.uid).toBe(anon.user.uid);
      expect(linked.user.isAnonymous).toBe(false);
      expect(getAdditionalUserInfo(linked as never)).toEqual({
        isNewUser: true,
        profile: {},
        providerId: 'password',
      });

      // Linking an email credential onto an already non-anonymous user reports isNewUser false.
      await signOut(h.clientAuth);
      authSandbox.setAuthProviderConfig(getSandboxAuth(h.sandbox), 'google.com', true);
      stageSignInResult(h.clientAuth, {
        user: { uid: 'google-only-uid', email: 'g@example.com' },
        providerId: 'google.com',
        operationType: 'signIn',
      });
      const googleSignedIn = await signInWithCredential(
        h.clientAuth,
        GoogleAuthProvider.credential('tok'),
      );
      const secondLink = await linkWithCredential(
        googleSignedIn.user,
        EmailAuthProvider.credential('second-1698@example.com', 'pw-123456'),
      );
      expect(secondLink.providerId).toBeNull();
      expect(getAdditionalUserInfo(secondLink as never)).toEqual({
        isNewUser: false,
        profile: {},
        providerId: 'password',
      });
    } finally {
      await h.close();
    }
  });

  it('rejects verifyBeforeUpdateEmail with auth/invalid-new-email for malformed target addresses (#1693)', async () => {
    const h = createBridgeHarness();
    try {
      const { user } = await createUserWithEmailAndPassword(
        h.clientAuth,
        'worker-1693@example.com',
        'pw-123456',
      );

      for (const bad of ['not-an-email', '', '@domain.com', 'local@']) {
        await expect(verifyBeforeUpdateEmail(user, bad)).rejects.toMatchObject({
          code: 'auth/invalid-new-email',
        });
      }
      await expect(sendPasswordResetEmail(h.clientAuth, 'not-an-email')).rejects.toMatchObject({
        code: 'auth/invalid-email',
      });
    } finally {
      await h.close();
    }
  });

  it('resolves ClientAuth.authStateReady after initial signed-out or restored port state settles (#1540)', async () => {
    const h = createBridgeHarness();
    try {
      expect(await h.clientAuth.authStateReady()).toBeUndefined();
      expect(h.clientAuth.currentUser).toBeNull();

      const created = await createUserWithEmailAndPassword(
        h.clientAuth,
        'ready-restore@example.com',
        'pw-123456',
      );
      expect(await h.clientAuth.authStateReady()).toBeUndefined();
      expect(h.clientAuth.currentUser?.uid).toBe(created.user.uid);

      // Simulate reload on a fresh port: restorePortSession queued before authStateReady().
      const reloaded = h.newClientAuth();
      try {
        void restorePortSession(reloaded.auth, created.user.uid);
        await reloaded.auth.authStateReady();
        expect(reloaded.auth.currentUser?.uid).toBe(created.user.uid);
        expect(reloaded.auth.currentUser?.email).toBe('ready-restore@example.com');
      } finally {
        await reloaded.close();
      }
    } finally {
      await h.close();
    }
  });
});
