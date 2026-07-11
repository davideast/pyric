/**
 * The bundle the import map serves for `firebase/auth`.
 *
 * DUAL-PATH (Phase 3c): when a SharedWorker is available, auth routes to the
 * ONE worker-hosted sandbox — shared user pool + data, PER-TAB sessions
 * (#754: each tab signs in as its own user). Otherwise it runs against the
 * in-page sandbox — the unchanged fallback. Branch picked ONCE at load
 * (`useWorker`).
 *
 * PROVIDER SIGN-IN (the no-regression seam): `signInWithPopup`/
 * `signInWithRedirect` can't cross the worker port — the `AuthFlowResolver`
 * (and its `ServeAuthHelper` picker) live in-page. So on the worker path we
 * RESOLVE the identity in-page (the helper, installed by `init.ts` on the
 * in-page auth), then hand it to the worker via `acceptProviderCredential`
 * (the `auth.acceptIdentity` op). Email/password + anonymous go straight to
 * the worker. The COMPLETE surface is exported on both paths (import-time
 * parity). Browser-bundled by `../bundler.ts`; never imported by node-side.
 */
import * as ipAuth from 'pyric/auth';
import { getAuth as pyricGetAuth, setPersistence as pyricSetPersistence } from 'pyric/auth';
import * as wcRaw from '../worker/client.js';
import { acceptProviderCredential } from '../worker/client.js';
import { sandbox, workerDb, useWorker, sessionStore } from './runtime.js';

// PROVIDER ENFORCEMENT SEAM: in worker mode the page-local sandbox is only
// the UI vehicle for popup/redirect resolution — the WORKER's provider config
// (what Studio's toggles write) is the authority, enforced by its
// `auth.acceptIdentity` gate. Delegate the page-local gate so the picker
// opens for providers the worker may have enabled (the page's defaults —
// password/anonymous only — would otherwise veto them sight unseen).
//
// NON-WORKER (in-page fallback) mode keeps LOCAL gating against the page
// sandbox's own config. There is no worker to consult in that mode, so the
// documented sandbox defaults (password/anonymous on, OAuth off until
// `sandbox.setAuthProviderConfig`) apply honestly — a deliberate, simple leg.
if (useWorker) {
  ipAuth.sandbox.delegateProviderEnforcement(pyricGetAuth(sandbox), true);
}

// Worker-client auth, cast to the canonical pyric/auth surface for the picked
// bindings (same names + shapes). Provider-bridge specifics are explicit below.
const wc = wcRaw as unknown as typeof ipAuth;

/** Observers + email/anon sign-in: worker-client or in-page. */
const A = useWorker ? wc : ipAuth;
export const onAuthStateChanged = A.onAuthStateChanged;
export const onIdTokenChanged = A.onIdTokenChanged;
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
export const getAuth = (
  useWorker
    ? (_app?: unknown) => wc.getAuth(workerDb as never)
    : (target?: Parameters<typeof pyricGetAuth>[0]) => pyricGetAuth((target ?? sandbox) as never)
) as typeof pyricGetAuth;

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
        sessionStore.setMode(persistence.type);
        return (wc.setPersistence as typeof pyricSetPersistence)(auth, persistence);
      })
    : async (
        auth: Parameters<typeof pyricSetPersistence>[0],
        persistence: Parameters<typeof pyricSetPersistence>[1],
      ) => {
        sessionStore.setMode(persistence.type);
        return pyricSetPersistence(auth, persistence);
      }
) as typeof pyricSetPersistence;

// ── Provider sign-in (popup/redirect) — the in-page→worker bridge ─────────

/**
 * Resolve a provider identity IN-PAGE (the ServeAuthHelper picker, via the
 * in-page auth's installed AuthFlowResolver), then hand it to the worker. The
 * helper seeds `{ sub, ...claims }` into the resolved credential's token, so we
 * strip `sub` to recover the original custom claims for the worker seed.
 *
 * Enforcement lives at the hand-off: `auth.acceptIdentity` gates against the
 * WORKER's provider config and rejects `auth/operation-not-allowed` for a
 * disabled provider (matching prod, where the popup opens and the error
 * surfaces after the interaction). The page-local gate is delegated above.
 */
async function bridgeProviderSignIn(
  provider: Parameters<typeof ipAuth.signInWithPopup>[1],
): Promise<unknown> {
  const inPageAuth = pyricGetAuth(sandbox);
  const cred = await ipAuth.signInWithPopup(inPageAuth, provider);
  const tokenResult = await cred.user.getIdTokenResult();
  const { sub: _sub, ...customClaims } = (tokenResult.claims ?? {}) as Record<string, unknown>;
  const providerId =
    cred.providerId ?? (provider as { providerId?: string }).providerId ?? 'oidc';
  return acceptProviderCredential(wc.getAuth(workerDb as never) as never, {
    uid: cred.user.uid,
    email: cred.user.email,
    displayName: cred.user.displayName,
    customClaims,
    providerId,
  });
}

export const signInWithPopup = (
  useWorker
    ? (_auth: unknown, provider: Parameters<typeof ipAuth.signInWithPopup>[1]) =>
        bridgeProviderSignIn(provider)
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
    ? (_auth: unknown, provider: Parameters<typeof ipAuth.signInWithRedirect>[1]) =>
        bridgeProviderSignIn(provider)
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
