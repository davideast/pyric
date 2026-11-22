/**
 * Regression suite for #1505: served `signInWithPopup` (and `signInWithRedirect`)
 * honors a result staged via `sandbox.mockSignInResult` on the port before
 * opening the sign-in picker, matching in-page `signInWithPopup`.
 */

import { describe, expect, it } from 'bun:test';
import { build } from 'esbuild';
import { join } from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
import { getAuth as getInPageAuth, sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

interface ServedAuthBundle {
  readonly app: typeof import('../../../src/serve/entries/app.js');
  readonly auth: typeof import('../../../src/serve/entries/auth.js');
  readonly helperRuntime: typeof import('../../../src/serve/entries/auth-helper-runtime.js');
  readonly pyricAuthSandbox: typeof import('pyric/auth').sandbox;
}

interface ServedRealm {
  readonly exports: ServedAuthBundle;
  readonly pickerRequests: Array<{ providerId: string; authType: string }>;
  dispose(): void;
}

const entriesDir = join(import.meta.dir, '../../../src/serve/entries');
let cachedBundleText: string | null = null;

async function getBundleText(): Promise<string> {
  if (cachedBundleText !== null) {
    return cachedBundleText;
  }
  const built = await build({
    stdin: {
      contents: `
        export * as app from './app.ts';
        export * as auth from './auth.ts';
        export * as helperRuntime from './auth-helper-runtime.ts';
        export { sandbox as pyricAuthSandbox } from 'pyric/auth';
      `,
      resolveDir: entriesDir,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    supported: { 'top-level-await': false },
    logLevel: 'silent',
  });
  const firstFile = built.outputFiles[0];
  if (firstFile === undefined) {
    throw new Error('Failed to bundle served auth entry for test realm');
  }
  cachedBundleText = firstFile.text;
  return cachedBundleText;
}

async function createServedWorkerRealm(ctx: HostCtx): Promise<ServedRealm> {
  const code = await getBundleText();
  const hostPorts: PortLike[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  class FakeWorkerPort {
    onmessage: ((event: MessageEvent<OutboundMessage>) => void) | null = null;
    private readonly hostPort: PortLike;

    constructor() {
      this.hostPort = {
        postMessage: (message: OutboundMessage) => {
          queueMicrotask(() => {
            this.onmessage?.(new MessageEvent('message', { data: message }));
          });
        },
      };
      hostPorts.push(this.hostPort);
    }

    postMessage(message: InboundMessage): void {
      void handleMessage(ctx, this.hostPort, message);
    }

    start(): void {}
    close(): void {}
  }

  class FakeSharedWorker {
    readonly port = new FakeWorkerPort();
    addEventListener(): void {}
  }

  const globals = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    MessageEvent,
    crypto,
    performance,
    queueMicrotask,
    structuredClone,
    location: new URL('https://app.example/'),
    SharedWorker: FakeSharedWorker,
    __PYRIC_WORKER_INIT__: { hosted: false, projectKey: null, bridgeUrl: null },
    setTimeout: (cb: () => void, ms: number) => {
      const t = setTimeout(cb, ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t: ReturnType<typeof setTimeout>) => {
      timers.delete(t);
      clearTimeout(t);
    },
    setInterval,
    clearInterval,
  };

  const context = createContext(globals);
  const mod = new SourceTextModule(code, { context });
  await mod.link(() => {
    throw new Error('Unexpected unresolved import in bundled served auth realm');
  });
  await mod.evaluate();

  const exports = mod.namespace as unknown as ServedAuthBundle;
  const pickerRequests: Array<{ providerId: string; authType: string }> = [];
  exports.helperRuntime.installServeAuthResolver({
    openPopup: async (request) => {
      pickerRequests.push({ providerId: request.providerId, authType: request.authType });
      return {
        user: {
          uid: `picked-${request.providerId}`,
          email: `picked-${request.providerId}@example.com`,
          displayName: 'Picked User',
          photoURL: null,
          emailVerified: true,
          isAnonymous: false,
          phoneNumber: null,
          providerId: 'firebase',
          providerData: [],
          tenantId: null,
          getIdToken: async () => 'picked-token',
          getIdTokenResult: async () => ({
            token: 'picked-token',
            claims: {},
            expirationTime: '',
            issuedAtTime: '',
            authTime: '',
            signInProvider: request.providerId,
            signInSecondFactor: null,
          }),
        },
        providerId: request.providerId,
        operationType: 'signIn',
      } as never;
    },
    openRedirect: async (request) => {
      pickerRequests.push({ providerId: request.providerId, authType: request.authType });
      return {
        user: {
          uid: `picked-redirect-${request.providerId}`,
          email: `picked-${request.providerId}@example.com`,
          displayName: 'Picked Redirect User',
          photoURL: null,
          emailVerified: true,
          isAnonymous: false,
          phoneNumber: null,
          providerId: 'firebase',
          providerData: [],
          tenantId: null,
          getIdToken: async () => 'picked-token',
          getIdTokenResult: async () => ({
            token: 'picked-token',
            claims: {},
            expirationTime: '',
            issuedAtTime: '',
            authTime: '',
            signInProvider: request.providerId,
            signInSecondFactor: null,
          }),
        },
        providerId: request.providerId,
        operationType: 'signIn',
      } as never;
    },
  });

  return {
    exports,
    pickerRequests,
    dispose() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const port of hostPorts) {
        cleanupPort(ctx, port);
      }
    },
  };
}

function makeHostCtx(): HostCtx {
  const sandbox = initializeSandbox();
  const inPageAuth = getInPageAuth(sandbox);
  authSandbox.setAuthProviderConfig(inPageAuth, 'google.com', true);
  authSandbox.setAuthProviderConfig(inPageAuth, 'github.com', true);
  authSandbox.setAuthProviderConfig(inPageAuth, 'oidc.acme', true);
  return {
    sandbox,
    db: getFirestore(sandbox),
    subs: new Map(),
    sessionMode: 'LOCAL',
    flushPersistence: async () => {},
  };
}

describe('served signInWithPopup staged result parity (#1505)', () => {
  it('consumes a staged result once without opening the picker, then falls back to the picker', async () => {
    const ctx = makeHostCtx();
    const realm = await createServedWorkerRealm(ctx);
    try {
      const { app, auth, pyricAuthSandbox } = realm.exports;
      const appInstance = app.initializeApp({ projectId: 'staged-popup-1' }, 'staged-popup-1');
      const authHandle = auth.getAuth(appInstance);

      const observedUids: Array<string | null> = [];
      const stop = auth.onAuthStateChanged(authHandle, (user) => {
        observedUids.push(user?.uid ?? null);
      });

      pyricAuthSandbox.mockSignInResult(authHandle, {
        user: {
          uid: 'staged-google-1',
          email: 'staged@example.com',
          displayName: 'Staged Google User',
          photoURL: 'https://example.com/staged.png',
          emailVerified: true,
        },
        providerId: 'google.com',
        operationType: 'signIn',
      } as never);

      const first = await auth.signInWithPopup(authHandle, new auth.GoogleAuthProvider());
      expect(realm.pickerRequests).toEqual([]);
      expect(first.user.uid).toBe('staged-google-1');
      expect(first.user.email).toBe('staged@example.com');
      expect(first.user.displayName).toBe('Staged Google User');
      expect(first.providerId).toBe('google.com');
      expect(authHandle.currentUser?.uid).toBe('staged-google-1');
      expect(observedUids).toContain('staged-google-1');

      // Second popup without re-staging must open the picker.
      const second = await auth.signInWithPopup(authHandle, new auth.GoogleAuthProvider());
      expect(realm.pickerRequests).toEqual([{ providerId: 'google.com', authType: 'signIn' }]);
      expect(second.user.uid).toBe('picked-google.com');

      stop();
    } finally {
      realm.dispose();
    }
  });

  it('keeps staged slots isolated by providerId and by port', async () => {
    const ctx = makeHostCtx();
    const realmA = await createServedWorkerRealm(ctx);
    const realmB = await createServedWorkerRealm(ctx);
    try {
      const appA = realmA.exports.app.initializeApp({ projectId: 'staged-iso' }, 'app-a');
      const authA = realmA.exports.auth.getAuth(appA);
      const appB = realmB.exports.app.initializeApp({ projectId: 'staged-iso' }, 'app-b');
      const authB = realmB.exports.auth.getAuth(appB);

      realmA.exports.pyricAuthSandbox.mockSignInResult(authA, {
        user: { uid: 'staged-gh', email: 'gh@example.com' },
        providerId: 'github.com',
        operationType: 'signIn',
      } as never);

      // Different port (realmB) cannot consume realmA's staged github.com result.
      const pickedOnB = await realmB.exports.auth.signInWithPopup(
        authB,
        new realmB.exports.auth.GithubAuthProvider(),
      );
      expect(realmB.pickerRequests).toEqual([{ providerId: 'github.com', authType: 'signIn' }]);
      expect(pickedOnB.user.uid).toBe('picked-github.com');

      // Different provider (google.com) on realmA opens the picker and leaves github.com staged.
      const pickedGoogleOnA = await realmA.exports.auth.signInWithPopup(
        authA,
        new realmA.exports.auth.GoogleAuthProvider(),
      );
      expect(realmA.pickerRequests).toEqual([{ providerId: 'google.com', authType: 'signIn' }]);
      expect(pickedGoogleOnA.user.uid).toBe('picked-google.com');

      // Matching provider (github.com) on realmA consumes the intact staged slot with no new picker call.
      const stagedGhOnA = await realmA.exports.auth.signInWithPopup(
        authA,
        new realmA.exports.auth.GithubAuthProvider(),
      );
      expect(realmA.pickerRequests).toEqual([{ providerId: 'google.com', authType: 'signIn' }]);
      expect(stagedGhOnA.user.uid).toBe('staged-gh');
    } finally {
      realmA.dispose();
      realmB.dispose();
    }
  });

  it('enforces disabled-provider auth/operation-not-allowed and honors tenantId and signInWithRedirect', async () => {
    const ctx = makeHostCtx();
    const realm = await createServedWorkerRealm(ctx);
    try {
      const { app, auth, pyricAuthSandbox } = realm.exports;
      const appInstance = app.initializeApp({ projectId: 'staged-tenant' }, 'staged-tenant');
      const authHandle = auth.getAuth(appInstance);

      // Disabled provider rejects auth/operation-not-allowed without opening the picker.
      authSandbox.setAuthProviderConfig(getInPageAuth(ctx.sandbox), 'google.com', false);
      pyricAuthSandbox.mockSignInResult(authHandle, {
        user: { uid: 'disabled-staged', email: 'dis@example.com' },
        providerId: 'google.com',
        operationType: 'signIn',
      } as never);
      let caughtCode = '';
      try {
        await auth.signInWithPopup(authHandle, new auth.GoogleAuthProvider());
      } catch (error) {
        caughtCode = String((error as { code?: unknown } | null)?.code ?? '');
      }
      expect(caughtCode).toBe('auth/operation-not-allowed');
      expect(realm.pickerRequests).toEqual([]);

      // Multi-tenant + custom OIDC provider + signInWithRedirect honors staged slot without picker.
      authHandle.tenantId = 'acme-tenant';
      pyricAuthSandbox.mockSignInResult(authHandle, {
        user: { uid: 'staged-oidc', email: 'oidc@example.com' },
        providerId: 'oidc.acme',
        operationType: 'signIn',
      } as never);
      await auth.signInWithRedirect(authHandle, new auth.OAuthProvider('oidc.acme'));
      expect(realm.pickerRequests).toEqual([]);
      expect(authHandle.currentUser?.uid).toBe('staged-oidc');
      expect(authHandle.currentUser?.tenantId).toBe('acme-tenant');
    } finally {
      realm.dispose();
    }
  });
});
