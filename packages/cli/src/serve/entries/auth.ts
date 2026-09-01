/**
 * The bundle the import map serves for `firebase/auth`.
 *
 * DUAL-PATH (Phase 3c): when a SharedWorker is available, auth routes to the
 * ONE worker-hosted sandbox — shared user pool + data, PER-TAB sessions
 * (#754: each tab signs in as its own user). Otherwise it runs against the
 * in-page sandbox — the unchanged fallback. Branch picked ONCE at load
 * (`useWorker`).
 *
 * PROVIDER SIGN-IN: the picker UI lives in-page, but its controller is
 * backend-free. In worker mode it lists identities from the worker and returns
 * a plain credential to `auth.acceptIdentity`; no page-local Auth handle signs
 * in or seeds a user. Email/password + anonymous also go straight to the
 * worker. The COMPLETE surface is exported on both paths (import-time parity).
 */
import './init.js';
import * as ipAuth from 'pyric/auth';
import { getAuth as pyricGetAuth, setPersistence as pyricSetPersistence } from 'pyric/auth';
import * as wcRaw from '../worker/client.js';
import { acceptProviderCredential, restorePortSession } from '../worker/client.js';
import { useWorker } from './worker-runtime.js';
import { sessionStoreForApp } from './app-session-store.js';
import { customClaimsFromTokenClaims } from './auth-helper-core.js';
import { resolveServeAuthFlow } from './auth-helper-runtime.js';
import type { SessionMode } from './session-store.js';
import { getApp, type FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import { workerClientForApp } from './app-client.js';
import { createActiveAuthRegistry } from './active-auth-registry.js';
import type { RuntimeIdentity } from '../runtime/identity.js';

// Worker-client auth, cast to the canonical pyric/auth surface for the picked
// bindings (same names + shapes). Provider-bridge specifics are explicit below.
const wc = wcRaw as unknown as typeof ipAuth;

/** Observers + email/anon sign-in: worker-client or in-page. */
const A = useWorker ? wc : ipAuth;
export const onAuthStateChanged = A.onAuthStateChanged;
export const onIdTokenChanged = A.onIdTokenChanged;
/**
 * Worker mode: the gate can't run before a worker-committed transition
 * (see `worker/client.ts`'s `beforeAuthStateChanged` doc) — registering
 * throws immediately rather than silently accepting a no-op callback.
 * In-page mode: full block-and-abort semantics via `pyric/auth`.
 */
export const beforeAuthStateChanged = A.beforeAuthStateChanged;
export const signInAnonymously = A.signInAnonymously;
export const signInWithEmailAndPassword = A.signInWithEmailAndPassword;
export const createUserWithEmailAndPassword = A.createUserWithEmailAndPassword;
export const signOut = A.signOut;
export const connectAuthEmulator = A.connectAuthEmulator;

/**
 * `updateProfile(user, { displayName?, photoURL? })` — updates the signed-in
 * user's profile on the picked path (worker or in-page). Both `wc` and `ipAuth`
 * export a top-level `updateProfile`; cast to the canonical `pyric/auth` shape.
 * (Fixes #746: the served `firebase/auth` entry didn't re-export this at all.)
 */
export const updateProfile = (useWorker ? wc.updateProfile : ipAuth.updateProfile) as typeof ipAuth.updateProfile;

// ── Provider value classes + persistence markers — path-independent ───────
export const GoogleAuthProvider = ipAuth.GoogleAuthProvider;
export const EmailAuthProvider = ipAuth.EmailAuthProvider;
export const FacebookAuthProvider = ipAuth.FacebookAuthProvider;
export const GithubAuthProvider = ipAuth.GithubAuthProvider;
export const OAuthProvider = ipAuth.OAuthProvider;
export const browserLocalPersistence = ipAuth.browserLocalPersistence;
export const browserSessionPersistence = ipAuth.browserSessionPersistence;
export const inMemoryPersistence = ipAuth.inMemoryPersistence;

// ── getAuth — worker-backed auth (reusing the shared worker port) or in-page.
const workerAuthByApp = new WeakMap<FirebaseApp, ReturnType<typeof pyricGetAuth>>();
const persistenceWired = new WeakSet<FirebaseApp>();

function wireAppPersistence(
  app: FirebaseApp,
  auth: ReturnType<typeof pyricGetAuth>,
): void {
  if (persistenceWired.has(app)) return;
  persistenceWired.add(app);
  const store = sessionStoreForApp(app);
  const stored = store.load();
  if (useWorker && stored) {
    // Posting restore before listener registration preserves FIFO ordering on
    // this app's MessagePort, so the initial listener value is the restore.
    void restorePortSession(auth as never, stored.uid).then((user) => {
      if (!user) store.clear();
    });
  } else if (!useWorker && stored) {
    try {
      ipAuth.sandbox.restoreSession(auth, stored.uid);
    } catch {
      store.clear();
    }
  }
  A.onAuthStateChanged(auth, (user) => {
    if (user) store.save(user.uid);
    else store.clear();
  });
}

const activeAuthRegistry = createActiveAuthRegistry<any>((auth, listener) => (
  (A.onAuthStateChanged as any)(auth, listener)
));

export function registerActiveAuth(auth: any): () => void {
  return activeAuthRegistry.register(auth);
}

export function subscribeToActiveAuth(listener: (user: any) => void): () => void {
  return activeAuthRegistry.subscribe(listener);
}

export function getActiveAuthUser(): RuntimeIdentity | null {
  for (const auth of activeAuthRegistry.auths()) {
    if (auth.currentUser) {
      return {
        uid: auth.currentUser.uid,
        email: auth.currentUser.email,
        displayName: auth.currentUser.displayName,
      };
    }
  }
  return null;
}

export async function switchAllAuthUsers(uid: string): Promise<void> {
  const promises: Promise<any>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(restorePortSession(auth as never, uid));
    } else {
      try {
        ipAuth.sandbox.restoreSession(auth, uid);
      } catch {
        // ignore
      }
    }
  }
  await Promise.all(promises);
}

export async function signOutAllAuths(): Promise<void> {
  const promises: Promise<any>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(wc.signOut(auth as never));
    } else {
      promises.push(ipAuth.signOut(auth));
    }
  }
  await Promise.all(promises);
}

export async function commitCredentialToAllAuths(identity: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  customClaims?: Record<string, unknown>;
  providerId?: string;
}): Promise<void> {
  const promises: Promise<any>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(acceptProviderCredential(auth as never, {
        uid: identity.uid,
        email: identity.email ?? null,
        displayName: identity.displayName ?? null,
        customClaims: identity.customClaims ?? {},
        providerId: identity.providerId ?? 'password',
      }));
    } else {
      try {
        ipAuth.sandbox.seedUsers(auth as never, [{
          uid: identity.uid,
          email: identity.email ?? '',
          password: 'synthetic-password',
          displayName: identity.displayName ?? undefined,
          customClaims: identity.customClaims ?? {},
          providerId: identity.providerId ?? 'password',
        }]);
      } catch {
        // Ignore seeding errors on fallback
      }
    }
  }
  await Promise.all(promises);
}

export const getAuth = ((app?: FirebaseApp) => {
  const resolved = app ?? getApp();
  if (!useWorker) {
    const handle = pyricGetAuth(resolved);
    wireAppPersistence(resolved, handle);
    const releaseActiveAuth = registerActiveAuth(handle);
    registerAppCleanup(resolved, releaseActiveAuth);
    return handle;
  }
  const existing = workerAuthByApp.get(resolved);
  if (existing) return existing;
  const client = workerClientForApp(resolved);
  const handle = Object.assign(wc.getAuth(client as never), {
    app: resolved,
  }) as unknown as ReturnType<typeof pyricGetAuth>;
  workerAuthByApp.set(resolved, handle);
  wireAppPersistence(resolved, handle);
  const releaseActiveAuth = registerActiveAuth(handle);
  registerAppCleanup(resolved, () => {
    workerAuthByApp.delete(resolved);
    releaseActiveAuth();
  });
  return handle;
}) as typeof pyricGetAuth;

/**
 * Narrow a `Persistence.type` to the three web-storage slots the session store
 * actually has.
 *
 * `'COOKIE'` (upstream's `browserCookiePersistence`, for SSR) is the fourth
 * member of the union and has no slot of its own here. It maps to `'LOCAL'`:
 * both are long-lived session storage, and the distinction is invisible to
 * consumer code once the session is restored either way. The alternative —
 * widening SessionMode — would add a storage backend the serve layer does not
 * have.
 */
function toSessionMode(type: 'LOCAL' | 'SESSION' | 'NONE' | 'COOKIE'): SessionMode {
  return type === 'COOKIE' ? 'LOCAL' : type;
}

/** `setPersistence`: selects which web storage holds THIS TAB's session (and
 *  migrates the current one). On the worker path the record is still client-
 *  side (#754 — per-port sessions restore via `auth.restorePortSession`); the
 *  RPC just keeps the worker's surface-parity mode in sync. */
export const setPersistence = (
  useWorker
    ? (async (
        auth: Parameters<typeof pyricSetPersistence>[0],
        persistence: Parameters<typeof pyricSetPersistence>[1],
      ) => {
        sessionStoreForApp(auth.app ?? getApp()).setMode(toSessionMode(persistence.type));
        return (wc.setPersistence as typeof pyricSetPersistence)(auth, persistence);
      })
    : async (
        auth: Parameters<typeof pyricSetPersistence>[0],
        persistence: Parameters<typeof pyricSetPersistence>[1],
      ) => {
        sessionStoreForApp(auth.app ?? getApp()).setMode(toSessionMode(persistence.type));
        return pyricSetPersistence(auth, persistence);
      }
) as typeof pyricSetPersistence;

// ── Provider sign-in (popup/redirect) — the in-page→worker bridge ─────────

/**
 * Resolve a provider identity through the backend-free ServeAuthHelper, then
 * hand it to the worker. The helper seeds `{ sub, ...claims, firebase }` into
 * the resolved credential's token, so we strip the synthesized `sub` and
 * `firebase` entries to recover the original custom claims for the worker
 * seed (see `customClaimsFromTokenClaims`).
 *
 * Enforcement lives at the hand-off: `auth.acceptIdentity` gates against the
 * WORKER's provider config and rejects `auth/operation-not-allowed` for a
 * disabled provider (matching prod, where the popup opens and the error
 * surfaces after the interaction).
 */
async function bridgeProviderSignIn(
  auth: Parameters<typeof ipAuth.signInWithPopup>[0],
  provider: Parameters<typeof ipAuth.signInWithPopup>[1],
  kind: 'popup' | 'redirect',
): Promise<unknown> {
  const providerId = (provider as { providerId?: string }).providerId ?? 'oidc';
  const cred = await resolveServeAuthFlow(
    { providerId, authType: 'signIn' },
    kind,
  );
  const tokenResult = await cred.user.getIdTokenResult();
  const customClaims = customClaimsFromTokenClaims(
    (tokenResult.claims ?? {}) as Record<string, unknown>,
  );
  return acceptProviderCredential(auth as never, {
    uid: cred.user.uid,
    email: cred.user.email,
    displayName: cred.user.displayName,
    customClaims,
    providerId,
  });
}

export const signInWithPopup = (
  useWorker
    ? (auth: Parameters<typeof ipAuth.signInWithPopup>[0], provider: Parameters<typeof ipAuth.signInWithPopup>[1]) =>
        bridgeProviderSignIn(auth, provider, 'popup')
    : ipAuth.signInWithPopup
) as typeof ipAuth.signInWithPopup;

/**
 * `signInWithRedirect` over the worker resolves like popup — the pyric
 * emulator helper does not actually navigate, so the identity is picked + the
 * worker signs in immediately. The result is delivered through the sign-in +
 * `onAuthStateChanged`; `getRedirectResult` returns null on the worker path
 * (there is no deferred post-navigation result to replay). v1 behavior.
 */
export const signInWithRedirect = (
  useWorker
    ? (auth: Parameters<typeof ipAuth.signInWithRedirect>[0], provider: Parameters<typeof ipAuth.signInWithRedirect>[1]) =>
        bridgeProviderSignIn(auth, provider, 'redirect')
    : ipAuth.signInWithRedirect
) as typeof ipAuth.signInWithRedirect;

export const getRedirectResult = (
  useWorker
    ? async (_auth?: unknown) => null
    : ipAuth.getRedirectResult
) as typeof ipAuth.getRedirectResult;

/** Direct credential sign-in: unsupported over the worker in v1 (the
 *  worker-client rejects with a clear error); in-page passes through. */
export const signInWithCredential = (
  useWorker ? wc.signInWithCredential : ipAuth.signInWithCredential
) as typeof ipAuth.signInWithCredential;

// ── Low-hanging-fruit exports (issue #149) ────────────────────────────────

function unsupportedWorkerAuthApi(name: string): never {
  throw new Error(
    `firebase/auth ${name}() is not supported over the pyric SharedWorker yet. ` +
      'Use the in-page fallback for this operation.',
  );
}

/** `initializeAuth(app, deps?)` — aliases the picked `getAuth` (worker- or
 *  in-page-backed). Path-independent: `deps` is accepted for parity, ignored. */
export const initializeAuth = ((app?: unknown, _deps?: unknown) =>
  getAuth(app as never)) as typeof ipAuth.initializeAuth;

/** `useDeviceLanguage(auth)` — accepted no-op (no device locale in the served
 *  sandbox). Path-independent. */
export const useDeviceLanguage = ((_auth?: unknown) => {}) as typeof ipAuth.useDeviceLanguage;

// User-mutation ops act on a `User` object. In-page they route through the
// sandbox User's dispatch hook; over the SharedWorker the client has no
// client-facing binding for them yet, so worker mode throws the standard
// "use the in-page fallback" error (mirrors the RTDB entry's unsupported ops).
export const deleteUser = (
  useWorker ? (() => unsupportedWorkerAuthApi('deleteUser')) : ipAuth.deleteUser
) as typeof ipAuth.deleteUser;
export const updateEmail = (
  useWorker ? (() => unsupportedWorkerAuthApi('updateEmail')) : ipAuth.updateEmail
) as typeof ipAuth.updateEmail;
export const updatePassword = (
  useWorker ? (() => unsupportedWorkerAuthApi('updatePassword')) : ipAuth.updatePassword
) as typeof ipAuth.updatePassword;
export const reload = (
  useWorker ? (() => unsupportedWorkerAuthApi('reload')) : ipAuth.reload
) as typeof ipAuth.reload;
export const updateCurrentUser = (
  useWorker ? (() => unsupportedWorkerAuthApi('updateCurrentUser')) : ipAuth.updateCurrentUser
) as typeof ipAuth.updateCurrentUser;
