/**
 * Dual-plane served/worker parity tests for PR 1 (`#1953`, `#1954`, `#1956`, `#1381`):
 * - Served `initializeAuth(app, { persistence: inMemoryPersistence | browserSessionPersistence })`
 * - Served `reload(user)` single `onIdTokenChanged` delivery
 * - Served `getIdTokenResult()` and `ServeAuthHelper` UTC timestamps + `signInSecondFactor`
 * - Two-port multi-tenant sign-out token cache isolation for one `uid` across two tenants
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  getAuth as ipGetAuth,
  sandbox as authSandbox,
  signInAnonymously as ipSignInAnonymously,
  signOut as ipSignOut,
} from 'pyric/auth';
import { ServeAuthHelper } from '../../../src/serve/entries/auth-helper-core.js';
import { sessionStoreForApp } from '../../../src/serve/entries/app-session-store.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { setPortSession } from '../../../src/serve/worker/host-auth.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { makeHostCtx, portPair, until, type FakePort } from './integration-support.js';
import { restoreSharedWorker } from './oracle-captures/support.ts';

const UTC_DATE_STRING_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const ISO_DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

function installWorkerBridge(ctx: HostCtx): void {
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
}

function nextApp(ctx: HostCtx, label: string): FirebaseApp {
  appSeq += 1;
  return createAppForSandbox(
    ctx.sandbox,
    { projectId: 'demo-auth-pr1', apiKey: 'demo-key' },
    `served-pr1-${label}-${appSeq}`,
  );
}

describe('Served & worker-plane Auth core parity (PR 1)', () => {
  restoreSharedWorker();

  it('#1953: served initializeAuth applies inMemoryPersistence and refuses conflicting second call', async () => {
    const ctx = await makeHostCtx();
    installWorkerBridge(ctx);
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = nextApp(ctx, 'init-mem');
    try {
      const store = sessionStoreForApp(app);
      const auth = servedAuth.initializeAuth(app, {
        persistence: servedAuth.inMemoryPersistence,
      });
      await servedAuth.createUserWithEmailAndPassword(auth, 'served-mem@example.com', 'password123');
      await until(() => auth.currentUser?.email === 'served-mem@example.com');

      // Nothing persisted to the app's SessionStore under inMemoryPersistence.
      expect(store.load()).toBeNull();
      expect(ctx.sessionMode).toBe('NONE');

      expect(() =>
        servedAuth.initializeAuth(app, { persistence: servedAuth.browserLocalPersistence }),
      ).toThrow(expect.objectContaining({ code: 'auth/already-initialized' }));
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('#1953: served initializeAuth with browserSessionPersistence or inMemoryPersistence does not restore or wipe a prior LOCAL session', async () => {
    const ctx = await makeHostCtx();
    installWorkerBridge(ctx);
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const sharedName = `served-pr1-isolated-${++appSeq}`;
    const appLocal = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-auth-pr1', apiKey: 'demo-key' },
      sharedName,
    );
    let appSession: FirebaseApp | null = null;
    let appMemory: FirebaseApp | null = null;
    let appReloaded: FirebaseApp | null = null;
    try {
      const localAuth = servedAuth.getAuth(appLocal);
      const localCred = await servedAuth.createUserWithEmailAndPassword(
        localAuth,
        'prior-local@example.com',
        'password123',
      );
      await until(() => sessionStoreForApp(appLocal).load(new Set(['LOCAL']))?.uid === localCred.user.uid);
      await deleteApp(appLocal);

      // Case A: re-initialize the same app name with browserSessionPersistence only.
      appSession = createAppForSandbox(
        ctx.sandbox,
        { projectId: 'demo-auth-pr1', apiKey: 'demo-key' },
        sharedName,
      );
      const sessionAuth = servedAuth.initializeAuth(appSession, {
        persistence: servedAuth.browserSessionPersistence,
      });
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(sessionAuth.currentUser).toBeNull();
      expect(sessionStoreForApp(appSession).getMode()).toBe('SESSION');
      expect(sessionStoreForApp(appSession).load(new Set(['SESSION']))).toBeNull();

      // Invalid setPersistence rejects with auth/argument-error without mutating store mode.
      await expect(
        servedAuth.setPersistence(sessionAuth, { type: 'BOGUS' } as never),
      ).rejects.toMatchObject({ code: 'auth/argument-error' });
      expect(sessionStoreForApp(appSession).getMode()).toBe('SESSION');
      expect(sessionStoreForApp(appSession).load(new Set(['LOCAL']))?.uid).toBe(localCred.user.uid);
      await deleteApp(appSession);
      appSession = null;

      // Case B: re-initialize the same app name with inMemoryPersistence only.
      appMemory = createAppForSandbox(
        ctx.sandbox,
        { projectId: 'demo-auth-pr1', apiKey: 'demo-key' },
        sharedName,
      );
      const memAuth = servedAuth.initializeAuth(appMemory, {
        persistence: servedAuth.inMemoryPersistence,
      });
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(memAuth.currentUser).toBeNull();
      expect(sessionStoreForApp(appMemory).getMode()).toBe('NONE');

      // Even signing in on the inMemoryPersistence handle leaves the prior LOCAL record intact.
      await servedAuth.signInAnonymously(memAuth);
      await until(() => memAuth.currentUser !== null);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sessionStoreForApp(appMemory).getMode()).toBe('NONE');
      expect(sessionStoreForApp(appMemory).load(new Set(['SESSION']))).toBeNull();
      await deleteApp(appMemory);
      appMemory = null;

      // A subsequent default getAuth(app) still restores the untouched prior LOCAL session.
      appReloaded = createAppForSandbox(
        ctx.sandbox,
        { projectId: 'demo-auth-pr1', apiKey: 'demo-key' },
        sharedName,
      );
      const restoredAuth = servedAuth.getAuth(appReloaded);
      await until(() => restoredAuth.currentUser?.uid === localCred.user.uid);
      expect(restoredAuth.currentUser?.uid).toBe(localCred.user.uid);
    } finally {
      if (appReloaded !== null) {
        sessionStoreForApp(appReloaded).clear();
        await deleteApp(appReloaded);
      }
      if (appMemory !== null) {
        sessionStoreForApp(appMemory).clear();
        await deleteApp(appMemory);
      }
      if (appSession !== null) {
        sessionStoreForApp(appSession).clear();
        await deleteApp(appSession);
      }
      ctx.sandbox.dispose();
    }
  });

  it('#1956: raw worker host emits ISO-8601 timestamps for native bridge clients while JS client normalizes to UTC strings', async () => {
    const ctx = await makeHostCtx();
    try {
      const messages: OutboundMessage[] = [];
      const port: PortLike = { postMessage: (msg) => messages.push(msg) };
      let seq = 0;

      async function send(payload: Record<string, unknown>): Promise<ResMessage> {
        const id = `wire-${++seq}`;
        await handleMessage(ctx, port, { ...payload, t: 'op', id } as InboundMessage);
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const entry = messages[i];
          if (entry !== undefined && entry.t === 'res' && entry.id === id) {
            return entry;
          }
        }
        throw new Error(`Missing response for ${id}`);
      }

      expect(await send({ method: 'auth.signInAnonymously' })).toMatchObject({ ok: true });
      const rawRes = (await send({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      })) as {
        ok: boolean;
        value?: {
          authTime: string;
          issuedAtTime: string;
          expirationTime: string;
          signInSecondFactor: string | null;
        };
      };
      expect(rawRes.ok).toBe(true);
      expect(rawRes.value?.authTime).toMatch(ISO_DATE_STRING_RE);
      expect(rawRes.value?.issuedAtTime).toMatch(ISO_DATE_STRING_RE);
      expect(rawRes.value?.expirationTime).toMatch(ISO_DATE_STRING_RE);
      expect(rawRes.value?.signInSecondFactor).toBeNull();
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('#1954 & #1956: served reload notifies onIdTokenChanged once and getIdTokenResult returns UTC strings + signInSecondFactor', async () => {
    const ctx = await makeHostCtx();
    installWorkerBridge(ctx);
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = nextApp(ctx, 'reload-and-token');
    try {
      const auth = servedAuth.getAuth(app);
      const cred = await servedAuth.createUserWithEmailAndPassword(
        auth,
        'served-reload@example.com',
        'password123',
      );
      const tokenResult = await cred.user.getIdTokenResult();
      expect(tokenResult.authTime).toMatch(UTC_DATE_STRING_RE);
      expect(tokenResult.issuedAtTime).toMatch(UTC_DATE_STRING_RE);
      expect(tokenResult.expirationTime).toMatch(UTC_DATE_STRING_RE);
      expect(Object.hasOwn(tokenResult, 'signInSecondFactor')).toBe(true);
      expect(tokenResult.signInSecondFactor).toBeNull();

      const idTokenEvents: Array<string | null> = [];
      const authStateEvents: Array<string | null> = [];
      const unsubId = servedAuth.onIdTokenChanged(auth, (u) => {
        idTokenEvents.push(u?.displayName ?? null);
      });
      const unsubAuth = servedAuth.onAuthStateChanged(auth, (u) => {
        authStateEvents.push(u?.uid ?? null);
      });
      await until(() => idTokenEvents.length >= 1 && authStateEvents.length >= 1);
      idTokenEvents.length = 0;
      authStateEvents.length = 0;

      authSandbox.updateUser(ipGetAuth(ctx.sandbox), cred.user.uid, {
        displayName: 'Served Reloaded',
      });
      await servedAuth.reload(cred.user);
      await until(() => idTokenEvents.length >= 1);
      // Let any stray extra deliveries settle before checking exact count.
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(idTokenEvents).toEqual(['Served Reloaded']);
      expect(authStateEvents).toEqual([]);

      unsubId();
      unsubAuth();
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('#1956: ServeAuthHelper bareCredential formats UTC times and includes signInSecondFactor', async () => {
    const helper = new ServeAuthHelper({ list: () => [] });
    const pending = helper.resolver().openPopup({ providerId: 'google.com', authType: 'signIn' });
    helper.add({
      email: 'helper@example.com',
      displayName: 'Helper User',
    });
    const cred = await pending;
    const result = await cred.user.getIdTokenResult();
    expect(result.authTime).toMatch(UTC_DATE_STRING_RE);
    expect(result.issuedAtTime).toMatch(UTC_DATE_STRING_RE);
    expect(result.expirationTime).toMatch(UTC_DATE_STRING_RE);
    expect(Object.hasOwn(result, 'signInSecondFactor')).toBe(true);
    expect(result.signInSecondFactor).toBeNull();
  });

  it('#1381: two ports with one uid and two tenants preserve the sibling tenant cached token on sign-out', async () => {
    const ctx = await makeHostCtx();
    try {
      const hostAuth = ipGetAuth(ctx.sandbox);
      const messagesA: OutboundMessage[] = [];
      const messagesB: OutboundMessage[] = [];
      const portA: PortLike = { postMessage: (msg) => messagesA.push(msg) };
      const portB: PortLike = { postMessage: (msg) => messagesB.push(msg) };
      let seq = 0;

      async function send(
        port: PortLike,
        messages: OutboundMessage[],
        payload: Record<string, unknown>,
      ): Promise<ResMessage> {
        const id = `p-${++seq}`;
        await handleMessage(ctx, port, { ...payload, t: 'op', id } as InboundMessage);
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const entry = messages[i];
          if (entry !== undefined && entry.t === 'res' && entry.id === id) {
            return entry;
          }
        }
        throw new Error(`Missing response for ${id}`);
      }

      // Sign in on tenant-a as sharedUid, then bind portA (tenant-a) and portB (tenant-b)
      // to the same uid on the shared SandboxBackend.
      hostAuth.tenantId = 'tenant-a';
      const signedInA = await ipSignInAnonymously(hostAuth);
      const sharedUid = signedInA.user.uid;
      const tokenA = await signedInA.user.getIdToken(false);

      const sessionA = authSandbox.mintSession(hostAuth, {
        kind: 'uid',
        uid: sharedUid,
        tenantId: 'tenant-a',
      });
      const sessionB = authSandbox.mintSession(hostAuth, {
        kind: 'uid',
        uid: sharedUid,
        tenantId: 'tenant-a',
      });
      (sessionB.user as { tenantId: string | null }).tenantId = 'tenant-b';
      sessionB.state.tenant = 'tenant-b';

      setPortSession(ctx, portA, sessionA);
      setPortSession(ctx, portB, sessionB);

      const portATokenBefore = (await send(portA, messagesA, {
        method: 'auth.getIdToken',
        forceRefresh: false,
      })) as { ok: boolean; value?: string };
      const portBTokenBefore = (await send(portB, messagesB, {
        method: 'auth.getIdToken',
        forceRefresh: false,
      })) as { ok: boolean; value?: string };
      expect(portATokenBefore.ok).toBe(true);
      expect(portBTokenBefore.ok).toBe(true);
      expect(portBTokenBefore.value).not.toBe(portATokenBefore.value);

      // Sign out portA and the tenant-a session on the shared backend.
      expect(await send(portA, messagesA, { method: 'auth.signOut' })).toMatchObject({ ok: true });
      await ipSignOut(hostAuth);

      // Port B (same uid, tenant-b) keeps the exact same cached token on getIdToken(false).
      const portBTokenAfter = (await send(portB, messagesB, {
        method: 'auth.getIdToken',
        forceRefresh: false,
      })) as { ok: boolean; value?: string };
      expect(portBTokenAfter.ok).toBe(true);
      expect(portBTokenAfter.value).toBe(portBTokenBefore.value);
      expect(tokenA.length).toBeGreaterThan(0);
    } finally {
      ctx.sandbox.dispose();
    }
  });
});
