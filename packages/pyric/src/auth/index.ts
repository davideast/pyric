/**
 * `pyric/auth` — modular Web-SDK Auth adapter for the Pyric
 * sandbox.
 *
 * Mirrors `firebase/auth`'s tree-shakable free-function surface
 * (`getAuth`, `signInAnonymously`, `signInWithEmailAndPassword`,
 * `onAuthStateChanged`, `signInWithPopup`, `GoogleAuthProvider`, …)
 * with two backends picked at init:
 *
 *   - **Sandbox target** — in-memory user DB + listener registry,
 *     drives `sandbox.currentUser` so service factories (a future
 *     `getFirestore(sandbox)` overload, follow-up PR) see identity
 *     changes without re-binding.
 *   - **Prod target** — delegates straight to `firebase/auth`.
 *
 * Same call surface across both. Agent code that writes against the
 * sandbox during iteration runs unmodified against prod at deploy.
 *
 * Dual-target dispatch follows the same pattern as `pyric/firestore`:
 *   - {@link TARGET_SYMBOL} brands every {@link Auth} handle.
 *   - {@link targetOf} (internal) reads it and switches on
 *     `target.kind`.
 *
 * Sandbox-only test driver lives under {@link sandbox}, mirroring
 * `pyric/firestore`'s `sandbox.setRules` etc. — each method throws
 * `failed-precondition` if called against a prod-backed handle.
 *
 * v0 scope is deliberately minimal. The deny-list is documented in
 * `docs/reference/feature-matrix.md`; agent `appSource` that imports
 * any of those will fail to bundle once the playground's
 * `firebase/auth` → `pyric/auth` alias swap lands.
 */

import { SandboxError, type Sandbox } from 'pyric/sandbox';
import type { FirebaseApp } from 'firebase/app';
import * as fb from 'firebase/auth';

// Phase 3 unified app handle. Adapter dispatch reads `APP_TARGET` and
// routes to the existing direct-handle path (sandbox vs prod).
import { APP_TARGET, type PyricApp } from 'pyric/app';

import {
  SandboxBackend,
  makeAuthError,
  type AuthUserRecord,
  type CreateUserRequest,
  type MintSessionRequest,
  type MintedSession,
  type SeedUser,
  type SignInIdentitySpec,
  type UpdateUserRequest,
} from './sandbox-backend.js';
import { targetOf, type ProdTarget, type SandboxTarget, type Target } from './target.js';
import {
  TARGET_SYMBOL,
  USER_INTERNAL,
  type Auth,
  type AuthFlowRequest,
  type AuthFlowResolver,
  type AuthObserver,
  type IdTokenResult,
  type Persistence,
  type Unsubscribe,
  type User,
  type UserCredential,
  type UserInfo,
  type UserInternal,
  type AuthCredential,
} from './types.js';
import {
  prodBeforeAuthStateChanged,
  prodCreateUserWithEmailAndPassword,
  prodCurrentUser,
  prodGetRedirectResult,
  prodOnAuthStateChanged,
  prodOnIdTokenChanged,
  prodSetPersistence,
  prodSignInAnonymously,
  prodSignInWithCredential,
  prodSignInWithEmailAndPassword,
  prodSignInWithPopup,
  prodSignInWithRedirect,
  prodSignOut,
} from './prod-backend.js';
import type { AuthProvider } from './providers.js';

// ─── Re-exports: types ────────────────────────────────────────────────

export type {
  Auth,
  AuthCredential,
  AuthFlowRequest,
  AuthFlowResolver,
  AuthObserver,
  IdTokenResult,
  Persistence,
  Unsubscribe,
  User,
  UserCredential,
  UserInfo,
};
export type { AuthProvider } from './providers.js';
export type {
  AuthUserRecord,
  CreateUserRequest,
  MintSessionRequest,
  MintedSession,
  ProviderUserInfo,
  SeedUser,
  SignInIdentitySpec,
  UpdateUserRequest,
} from './sandbox-backend.js';
export { TARGET_SYMBOL } from './types.js';

// ─── Re-exports: provider classes ─────────────────────────────────────

export {
  EmailAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  FEDERATED_PROVIDER_IDS,
  type FederatedProviderId,
} from './providers.js';

// ─── Persistence markers ──────────────────────────────────────────────
//
// Opaque markers — sandbox treats them as no-ops, prod backend maps
// them to upstream's `inMemoryPersistence` / `browserSessionPersistence`
// / `browserLocalPersistence` singletons via `setPersistence`.

export const inMemoryPersistence: Persistence = { type: 'NONE' };
export const browserSessionPersistence: Persistence = { type: 'SESSION' };
export const browserLocalPersistence: Persistence = { type: 'LOCAL' };

// ─── Memoization: one backend per sandbox ─────────────────────────────
//
// `firebase/auth.getAuth(app)` is idempotent — repeat calls for the
// same app return the same Auth instance. Mirror that on the sandbox
// side so listeners registered against one handle see changes
// driven through another handle for the same sandbox.

const sandboxBackends = new WeakMap<Sandbox, SandboxBackend>();
const sandboxHandles = new WeakMap<Sandbox, Auth>();
// Prod handles are memoized per underlying `fb.Auth`. `fb.getAuth(app)`
// is itself idempotent (same `fb.Auth` per app), but our *wrapper*
// handle was minted fresh on every `getAuth(app)` call — so
// `getAuth(app) !== getAuth(app)`, contradicting the docstring + COMPAT.
// Keying on the resolved `fb.Auth` makes the wrapper idempotent too,
// matching the sandbox side (AUTH-B6).
const prodHandles = new WeakMap<fb.Auth, Auth>();

function backendFor(sandbox: Sandbox): SandboxBackend {
  let backend = sandboxBackends.get(sandbox);
  if (!backend) {
    backend = new SandboxBackend(sandbox);
    sandboxBackends.set(sandbox, backend);
    // Register the auth user DB as a persistable service on the sandbox.
    // This is the primary hook that makes `enablePersistence` include auth
    // users in the serialized blob and restore them on reload.
    //
    // Registration is guarded by the backendFor memoization — we only
    // reach this branch ONCE per sandbox, so double-registration is
    // impossible in practice. `registerPersistableService` throws on
    // duplicates anyway, which would surface as a bug if the invariant
    // were ever broken.
    //
    // Capture `backend` in the closure via a local so the let-binding
    // can be reassigned without breaking the hooks (TypeScript narrows it
    // as non-null here, but the closures below need a stable reference).
    const capturedBackend = backend;
    sandbox.registerPersistableService('auth', {
      snapshot: () => ({
        users: capturedBackend.exportUsers(),
        providers: capturedBackend.exportProviderConfig(),
      }),
      restore: (data: unknown) => {
        const d = data as { users?: SeedUser[]; providers?: Record<string, boolean> };
        // Restore is a REPLACE, not a merge: the user DB becomes EXACTLY what
        // the snapshot holds. On boot / late-registration the backend is empty,
        // so clearUsers() is a no-op; for a runtime `sandbox.loadSnapshot()`
        // (transfer / branch switch) it drops users that diverged after the
        // snapshot was taken, so the clobber is total.
        capturedBackend.clearUsers();
        if (Array.isArray(d?.users) && d.users.length > 0) {
          capturedBackend.seedUsers(d.users);
        }
        // Same REPLACE policy for provider config. `restoreProviderConfig`
        // falls back to the documented defaults when `d?.providers` is
        // missing (a blob written before this feature existed), so older
        // `--persist` files don't silently disable password/anonymous.
        capturedBackend.restoreProviderConfig(d?.providers);
      },
      subscribe: (onChange: () => void) => {
        const unsubUsers = capturedBackend.subscribeUsers(onChange);
        const unsubProviders = capturedBackend.subscribeProviderConfig(onChange);
        return () => {
          unsubUsers();
          unsubProviders();
        };
      },

      // Session hooks — the persistence controller uses these to save and
      // restore the CURRENTLY SIGNED-IN USER (the session), separate from
      // the user database (handled above by snapshot/restore). The controller
      // only activates session persistence when `sessionStorage` is injected
      // into `enablePersistence` options; when omitted the hooks exist but
      // are never called (no fake durability in non-browser environments).
      session: {
        currentUid: () => sandbox.currentUser?.uid ?? null,
        restore: (uid: string) => capturedBackend.restoreSession(uid),
        mode: () => capturedBackend.getPersistenceMode(),
        subscribe: (onChange: () => void) => capturedBackend.subscribeSession(onChange),
      },
    });
  }
  return backend;
}

/**
 * Construct an {@link Auth} handle. Two overloads:
 *   - `getAuth(sandbox)` — sandbox-backed.
 *   - `getAuth(app)` — prod-backed; delegates to
 *     `firebase/auth.getAuth(app)`.
 *
 * Idempotent on both targets — calling twice for the same input
 * returns the same handle.
 *
 * @example
 * ```ts
 * // Sandbox.
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAuth, signInAnonymously } from 'pyric/auth';
 * const sandbox = initializeSandbox();
 * const auth = getAuth(sandbox);
 * await signInAnonymously(auth);
 *
 * // Prod.
 * import { initializeApp } from 'firebase/app';
 * import { getAuth } from 'pyric/auth';
 * const app = initializeApp(userProjectConfig);
 * const auth = getAuth(app);
 * ```
 */
export function getAuth(sandbox: Sandbox): Auth;
export function getAuth(app: FirebaseApp): Auth;
export function getAuth(app: PyricApp): Auth;
export function getAuth(target: Sandbox | FirebaseApp | PyricApp): Auth {
  // PyricApp dispatch: inspect the brand and forward to the existing
  // direct-handle path. Ordered ABOVE the structural `isSandbox`
  // sniff so a PyricApp's outer object (which doesn't itself carry
  // `withAuth`) doesn't accidentally match either branch — and so a
  // sandbox-app routes into the cached sandbox handle.
  if (isPyricApp(target)) {
    return target[APP_TARGET] === 'sandbox'
      ? getAuth(target.sandbox)
      : getAuth(target.firebaseApp);
  }
  if (isSandbox(target)) {
    let handle = sandboxHandles.get(target);
    if (handle) return handle;
    const backend = backendFor(target);
    const t: SandboxTarget = { kind: 'sandbox', sandbox: target, backend };
    handle = makeAuthHandle(t);
    sandboxHandles.set(target, handle);
    return handle;
  }
  const fbAuth = fb.getAuth(target);
  let handle = prodHandles.get(fbAuth);
  if (handle) return handle;
  const t: ProdTarget = { kind: 'prod', auth: fbAuth };
  handle = makeAuthHandle(t);
  prodHandles.set(fbAuth, handle);
  return handle;
}

/**
 * `initializeAuth(app, deps?)` — mirror of `firebase/auth`'s explicit
 * initializer. Aliases {@link getAuth}: returns the same stable `Auth`
 * handle for the app, so an app that calls `initializeAuth` instead of
 * `getAuth` gets an equivalent, working instance.
 *
 * The optional `Dependencies` argument (persistence / popupRedirectResolver)
 * is accepted for signature parity but not applied — persistence is already
 * a documented no-op in the sandbox model (`setPersistence`, the persistence
 * markers), so there is nothing new to configure. Unlike prod, calling this
 * twice for the same app does NOT throw `auth/already-initialized`; it
 * returns the cached handle (same leniency as repeated `getAuth`).
 */
export function initializeAuth(
  app: Sandbox | FirebaseApp | PyricApp,
  deps?: unknown,
): Auth {
  void deps;
  return getAuth(app as never);
}

/**
 * Brand-based test for the {@link PyricApp} overload. Reads the
 * `APP_TARGET` symbol that `pyric/app`'s `initializeApp` stamps on
 * every handle. Cheap + collision-free: a `Sandbox` / `FirebaseApp`
 * will never carry this symbol.
 */
function isPyricApp(target: Sandbox | FirebaseApp | PyricApp): target is PyricApp {
  return (
    target !== null
    && typeof target === 'object'
    && APP_TARGET in target
  );
}

/**
 * Brand-based discriminator for `getAuth`. A {@link Sandbox} carries
 * the `onCurrentUserChanged` method (and `currentUser` accessor)
 * which a `FirebaseApp` will never have; structural sniff is cheap
 * and stable.
 */
function isSandbox(target: Sandbox | FirebaseApp): target is Sandbox {
  return (
    typeof target === 'object'
    && target !== null
    && typeof (target as Sandbox).onCurrentUserChanged === 'function'
    && typeof (target as Sandbox).withAuth === 'function'
  );
}

/**
 * Build an Auth handle. `currentUser` is a getter so each access
 * reads through to the live backend state — consumer code that holds
 * an `auth` reference always sees the latest user (matches
 * `firebase/auth`).
 */
function makeAuthHandle(target: Target): Auth {
  const handle = {
    [TARGET_SYMBOL]: target,
    // Method form of `signOut(auth)` — `firebase/auth`'s `Auth` exposes
    // both the free function and this method (AUTH-GAP). Delegates to the
    // free function so the two share one code path.
    signOut(): Promise<void> {
      return signOut(handle as Auth);
    },
  } as Auth;
  return Object.defineProperty(handle, 'currentUser', {
    enumerable: true,
    get(): User | null {
      return target.kind === 'sandbox'
        ? target.backend.getCurrentUser()
        : prodCurrentUser(target.auth);
    },
  });
}

// ─── Emulator wiring ──────────────────────────────────────────────────

/**
 * `connectAuthEmulator(auth, url, options?)` — on sandbox handles
 * this is a no-op (the sandbox IS the emulator); on prod it
 * delegates straight to `firebase/auth.connectAuthEmulator`.
 *
 * Same signature as upstream so consumer code that calls this at
 * init time works against both backends unchanged.
 */
export function connectAuthEmulator(
  auth: Auth,
  url: string,
  options?: { disableWarnings?: boolean },
): void {
  const target = targetOf(auth);
  if (target.kind === 'sandbox') return;
  // Upstream types require `disableWarnings: boolean` (not optional);
  // normalize to false when callers omit it.
  fb.connectAuthEmulator(target.auth, url, {
    disableWarnings: options?.disableWarnings ?? false,
  });
}

// ─── Sign-in / out free functions ─────────────────────────────────────

export async function signInAnonymously(auth: Auth): Promise<UserCredential> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSignInAnonymously(target.auth);
  target.backend.assertProviderEnabled('anonymous');
  // Match `firebase/auth` semantics: if there's already an anonymous
  // user signed in, reuse them rather than minting a fresh uid.
  // Production persists anonymous users across page loads via the
  // configured Persistence; the sandbox has no equivalent, but within
  // a single sandbox lifetime an already-signed-in anonymous user is
  // the same identity from the consumer's perspective. Without this
  // check, React StrictMode (or any double-mount pattern) leaks a
  // new anonymous user per mount — `anonymous-1`, `anonymous-2`, …
  // each with their own owner-only profile docs nobody can clean up.
  const existing = target.backend.getCurrentUser();
  if (existing && existing.isAnonymous) {
    return { user: existing, providerId: null, operationType: 'signIn' };
  }
  const user = target.backend.mintAnonymousUser();
  await target.backend.transitionCurrentUser(user, 'anonymous');
  return { user, providerId: null, operationType: 'signIn' };
}

export async function signInWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  const target = targetOf(auth);
  if (target.kind === 'prod') {
    return prodSignInWithEmailAndPassword(target.auth, email, password);
  }
  target.backend.assertProviderEnabled('password');
  const stored = target.backend.validatePassword(email, password);
  const user = target.backend.buildUserFromStored(stored);
  // The backend records the originating provider ('password') on the
  // identity for provider tracking, while the credential's providerId
  // stays null for email/password — matches prod. Upstream
  // `providerIdForResponse` returns null when the token response carries
  // no providerId (email/password responses don't; only OAuth/phone do —
  // `core/user/user_credential_impl.ts:84-96`). Oracle:
  // packages/conformance/observations/auth/auth-createUser-operationType.json pins
  // providerId: null against prod (AUTH-B2).
  await target.backend.transitionCurrentUser(user, 'password');
  return { user, providerId: null, operationType: 'signIn' };
}

export async function createUserWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  const target = targetOf(auth);
  if (target.kind === 'prod') {
    return prodCreateUserWithEmailAndPassword(target.auth, email, password);
  }
  target.backend.assertProviderEnabled('password');
  const stored = target.backend.createEmailPasswordUser(email, password);
  const user = target.backend.buildUserFromStored(stored);
  // providerId: null — same rationale as signInWithEmailAndPassword above
  // (the exact field the oracle capture contradicted; audit H6 / AUTH-B2);
  // 'password' still recorded on the identity for provider tracking.
  await target.backend.transitionCurrentUser(user, 'password');
  return { user, providerId: null, operationType: 'signIn' };
}

export async function signOut(auth: Auth): Promise<void> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSignOut(target.auth);
  await target.backend.transitionCurrentUser(null);
}

export async function setPersistence(auth: Auth, persistence: Persistence): Promise<void> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSetPersistence(target.auth, persistence);
  // Sandbox: record the mode on the backend so the persistence controller
  // can pick the right web-storage slot (local / session / none) for the
  // current session. The backend's setPersistenceMode notifies session-
  // change subscribers, causing the controller to immediately migrate any
  // stored uid to the new store — matching the real SDK's setMode behavior
  // where the active session follows the new persistence target.
  //
  // Mode mapping: our persistence markers carry `.type` strings that match
  // the `'LOCAL' | 'SESSION' | 'NONE'` enum exactly.
  //   inMemoryPersistence       → { type: 'NONE' }
  //   browserSessionPersistence → { type: 'SESSION' }
  //   browserLocalPersistence   → { type: 'LOCAL' }
  const modeMap: Record<string, 'LOCAL' | 'SESSION' | 'NONE'> = {
    LOCAL: 'LOCAL',
    SESSION: 'SESSION',
    NONE: 'NONE',
  };
  const mode = modeMap[persistence.type] ?? 'LOCAL';
  target.backend.setPersistenceMode(mode);
}

/**
 * Resolve a popup/redirect sign-in to a `UserCredential`, mirroring
 * `firebase/auth`'s `_withDefaultResolver` precedence:
 *   per-call resolver → injected resolver → one-shot mock → throw.
 * With nothing configured it throws `auth/argument-error` (exactly what
 * upstream throws with no resolver), naming the API that was actually
 * called. The one-shot mock keeps headless conformance deterministic.
 */
async function resolveFlow(
  backend: SandboxTarget['backend'],
  provider: AuthProvider,
  authType: AuthFlowRequest['authType'],
  perCall: AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
): Promise<UserCredential> {
  // Gate BEFORE touching the resolver/mock registry, so a disabled provider
  // throws `auth/operation-not-allowed` — distinct from the `auth/argument-
  // error` below, which keeps meaning "enabled, but no resolver/mock wired".
  backend.assertProviderEnabled(provider.providerId);
  const req: AuthFlowRequest = { providerId: provider.providerId, authType };
  const resolver = perCall ?? backend.getResolver();
  if (resolver) return kind === 'popup' ? resolver.openPopup(req) : resolver.openRedirect(req);
  const mock = backend.consumeMockResult(provider.providerId);
  if (mock) return mock;
  const api = kind === 'popup' ? 'signInWithPopup' : 'signInWithRedirect';
  throw makeAuthError(
    'auth/argument-error',
    `${api}(provider: ${provider.providerId}): no AuthFlowResolver configured. Inject one with sandbox.setAuthFlowResolver(auth, resolver), pass one as the 3rd argument, or pre-stage a result with sandbox.mockSignInResult(auth, {user, providerId: '${provider.providerId}', …}).`,
  );
}

/**
 * The `resolver` argument is sandbox-only: on a prod-backed handle the
 * call delegates to `firebase/auth`, which uses its own platform default
 * (browser) resolver, and this argument is ignored.
 */
export async function signInWithPopup(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSignInWithPopup(target.auth, provider);
  const cred = await resolveFlow(target.backend, provider, 'signIn', resolver, 'popup');
  const providerId = cred.providerId ?? provider.providerId;
  target.backend.assertSignInAllowed(cred.user.uid);
  target.backend.recordProviderSignIn(cred.user, providerId);
  await target.backend.transitionCurrentUser(cred.user, providerId);
  return cred;
}

/**
 * The `resolver` argument is sandbox-only — see {@link signInWithPopup}.
 */
export async function signInWithRedirect(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<void> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSignInWithRedirect(target.auth, provider);
  // Sandbox has no navigation, so the resolver resolves inline; stash the
  // credential + sign in so getRedirectResult returns it once (matches the
  // observable prod outcome: after the redirect completes the user is
  // signed in and getRedirectResult yields the credential).
  const cred = await resolveFlow(target.backend, provider, 'signIn', resolver, 'redirect');
  const providerId = cred.providerId ?? provider.providerId;
  target.backend.assertSignInAllowed(cred.user.uid);
  target.backend.recordProviderSignIn(cred.user, providerId);
  // Gate BEFORE stashing the redirect result — a blocked transition
  // means the identity never became the signed-in user, so
  // `getRedirectResult` shouldn't hand it back either (matches
  // upstream's `_overrideRedirectResult` swap to a rejection on block).
  await target.backend.transitionCurrentUser(cred.user, providerId);
  target.backend.setRedirectResult(cred);
}

export async function getRedirectResult(
  auth: Auth,
  _resolver?: AuthFlowResolver,
): Promise<UserCredential | null> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodGetRedirectResult(target.auth);
  return target.backend.takeRedirectResult();
}

export async function signInWithCredential(
  auth: Auth,
  credential: AuthCredential,
): Promise<UserCredential> {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodSignInWithCredential(target.auth, credential);
  const providerId = credential.providerId;
  // Gate BEFORE consuming the mock — see the `resolveFlow` gating note above
  // for why `operation-not-allowed` must fire ahead of the mock-registry check.
  target.backend.assertProviderEnabled(providerId);
  const mock = target.backend.consumeMockResult(providerId);
  if (!mock) {
    throw makeAuthError(
      'auth/no-mock-configured',
      `signInWithCredential(providerId: ${providerId}): no mock configured. Pre-stage with sandbox.mockSignInResult(auth, {user, providerId: '${providerId}', …}).`,
    );
  }
  const credProviderId = mock.providerId ?? providerId;
  target.backend.assertSignInAllowed(mock.user.uid);
  target.backend.recordProviderSignIn(mock.user, credProviderId);
  await target.backend.transitionCurrentUser(mock.user, credProviderId);
  return mock;
}

// ─── Observers ────────────────────────────────────────────────────────

export function onAuthStateChanged(auth: Auth, observer: AuthObserver): Unsubscribe {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodOnAuthStateChanged(target.auth, observer);
  return target.backend.subscribe('auth-state', observer);
}

export function onIdTokenChanged(auth: Auth, observer: AuthObserver): Unsubscribe {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodOnIdTokenChanged(target.auth, observer);
  // Sandbox: fires on identity transitions AND on
  // `getIdToken(true)` forced refreshes — matches prod.
  // Oracle: packages/conformance/observations/auth/auth-onidtokenchanged-force-refresh.json
  return target.backend.subscribe('id-token', observer);
}

/**
 * Top-level mirror of `firebase/auth`'s `beforeAuthStateChanged(auth,
 * callback, onAbort?)` — a BLOCKING gate that runs before a real
 * sign-in/sign-out transition commits. Registered callbacks run in
 * registration order; if one throws (or its returned promise rejects),
 * the transition is aborted: the pending `signInWith…` / `signOut`
 * call rejects with `auth/login-blocked`, `currentUser` is left
 * unchanged, and `onAuthStateChanged` / `onIdTokenChanged` do NOT fire.
 * Every `onAbort` registered by a callback that already ran
 * successfully in this pass is invoked (in reverse registration order)
 * so side effects can be undone.
 *
 * Fires for both directions — a real sign-in (`nextUser` non-null) and
 * a real sign-out (`nextUser === null`). Does NOT fire for
 * `sandbox.setUser` — that test driver bypasses the gate the same way
 * it bypasses provider enforcement (no prod analog; see its doc
 * comment under {@link sandbox}).
 *
 * Sandbox target only runs one queue per `Auth` handle — mirrors
 * upstream, where the queue lives on the `AuthImpl` instance.
 */
export function beforeAuthStateChanged(
  auth: Auth,
  callback: (user: User | null) => void | Promise<void>,
  onAbort?: () => void,
): Unsubscribe {
  const target = targetOf(auth);
  if (target.kind === 'prod') return prodBeforeAuthStateChanged(target.auth, callback, onAbort);
  return target.backend.beforeAuthStateChanged(callback, onAbort);
}

// ─── Token accessors ──────────────────────────────────────────────────

/**
 * Top-level mirror of `firebase/auth`'s `getIdToken(user)`. Delegates
 * to the method on the user handle, so it works on both backends.
 *
 * Parity provenance: W1.5 grid (2026-06-10) — generated apps import
 * the modular free function, and its absence failed every render of
 * the claims-driven fixtures.
 */
export async function getIdToken(user: User, forceRefresh?: boolean): Promise<string> {
  return user.getIdToken(forceRefresh);
}

/** Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`. */
export async function getIdTokenResult(
  user: User,
  forceRefresh?: boolean,
): Promise<IdTokenResult> {
  return user.getIdTokenResult(forceRefresh);
}

/**
 * Top-level mirror of `firebase/auth`'s `updateProfile(user, profile)`.
 * Updates the signed-in user's `displayName` / `photoURL` — pass `null` to
 * clear a field, omit it to leave it untouched. Mutates the user object in
 * place (held references, including `auth.currentUser`, reflect the change).
 *
 * Dispatches through the hidden {@link USER_INTERNAL} hook the backend stamps
 * on every `User`, so it routes correctly WITHOUT an `auth` handle — matching
 * upstream's user-only signature. Works on both sandbox and prod targets.
 *
 * Per `firebase/auth`, this does NOT fire `onAuthStateChanged` /
 * `onIdTokenChanged`.
 */
export async function updateProfile(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  const internal = (user as { [USER_INTERNAL]?: UserInternal })[USER_INTERNAL];
  if (!internal) {
    throw makeAuthError(
      'auth/invalid-user-token',
      'updateProfile: unrecognized user — was it produced by a pyric/auth sign-in?',
    );
  }
  return internal.updateProfile(profile);
}

/**
 * Top-level mirror of `firebase/auth`'s `deleteUser(user)`. Deletes the
 * account from the store and signs the user out if they are the current
 * user (fires `onAuthStateChanged(null)`) — matching prod, where deleting
 * the signed-in user clears `auth.currentUser`. Real behavior on the
 * sandbox: a subsequent `signInWithEmailAndPassword` for that identity
 * throws `auth/user-not-found`.
 *
 * Routes through the hidden {@link USER_INTERNAL} hook (user-only
 * signature, no `auth` handle), so it works on sandbox + prod targets.
 */
export async function deleteUser(user: User): Promise<void> {
  return userInternal(user, 'deleteUser').delete();
}

/**
 * Top-level mirror of `firebase/auth`'s `updateEmail(user, newEmail)`.
 * Changes the signed-in user's email in the store (rejecting
 * `auth/email-already-in-use` / `auth/invalid-email`) and mutates the held
 * `user` in place. Real behavior: the next sign-in resolves against the
 * new email.
 *
 * Leniency vs prod: the sandbox does NOT enforce `auth/requires-recent-login`
 * and does not route through `verifyBeforeUpdateEmail` — see the COMPAT row.
 */
export async function updateEmail(user: User, newEmail: string): Promise<void> {
  return userInternal(user, 'updateEmail').updateEmail(newEmail);
}

/**
 * Top-level mirror of `firebase/auth`'s `updatePassword(user, newPassword)`.
 * Sets the stored password (validated for strength). Real behavior: the
 * sandbox stores AND verifies passwords, so the next
 * `signInWithEmailAndPassword` with the new password succeeds and the old
 * one throws `auth/wrong-password`.
 *
 * Leniency vs prod: no `auth/requires-recent-login` enforcement — see the
 * COMPAT row.
 */
export async function updatePassword(user: User, newPassword: string): Promise<void> {
  return userInternal(user, 'updatePassword').updatePassword(newPassword);
}

/**
 * Top-level mirror of `firebase/auth`'s `reload(user)`. Re-reads the stored
 * record into the `user` object in place so out-of-band changes (e.g.
 * `sandbox.updateUser`) are reflected — matching prod's server refresh.
 */
export async function reload(user: User): Promise<void> {
  return userInternal(user, 'reload').reload();
}

/**
 * Top-level mirror of `firebase/auth`'s `updateCurrentUser(auth, user)`.
 * Sets the sandbox's current user (pass `null` to sign out), firing
 * `onAuthStateChanged`. Real behavior — `auth.currentUser` reflects the
 * passed user afterward.
 */
export async function updateCurrentUser(auth: Auth, user: User | null): Promise<void> {
  const target = targetOf(auth);
  if (target.kind === 'sandbox') {
    target.backend.setCurrentUser(user);
    return;
  }
  // Prod: hand the UNDERLYING upstream user to `firebase/auth`, recovered
  // from the adapter's USER_INTERNAL hook.
  const raw = user ? (userInternal(user, 'updateCurrentUser').raw as fb.User) : null;
  return fb.updateCurrentUser(target.auth, raw);
}

/**
 * `useDeviceLanguage(auth)` — accepted no-op. The sandbox has no device
 * locale to read, so there is no language to set; the call is accepted so
 * init code that calls it compiles + runs. `diverged-documented`.
 */
export function useDeviceLanguage(auth: Auth): void {
  void auth;
}

/**
 * Recover the backend-dispatch hook stamped on every `User`. Throws
 * `auth/invalid-user-token` for a user not produced by a `pyric/auth`
 * sign-in — same guard {@link updateProfile} uses.
 */
function userInternal(user: User, name: string): UserInternal {
  const internal = (user as { [USER_INTERNAL]?: UserInternal })[USER_INTERNAL];
  if (!internal) {
    throw makeAuthError(
      'auth/invalid-user-token',
      `${name}: unrecognized user — was it produced by a pyric/auth sign-in?`,
    );
  }
  return internal;
}

// ─── Sandbox-only test driver ─────────────────────────────────────────

/**
 * Sandbox-only lifecycle / test-driver surface. Throws
 * `failed-precondition` on prod-backed handles — mirrors the
 * `pyric/firestore` `sandbox.*` pattern.
 *
 * **Naming note:** the `sandbox` export name collides with the
 * common `const sandbox = initializeSandbox()` local. Alias on
 * import if both are in scope:
 *
 * ```ts
 * import { sandbox as authSandbox } from 'pyric/auth';
 * import { initializeSandbox } from 'pyric/sandbox';
 * const sandbox = initializeSandbox();
 * const auth = getAuth(sandbox);
 * authSandbox.seedUsers(auth, […]);
 * ```
 */
export const sandbox = {
  /**
   * Force the current user (and emit to listeners). Pass `null` to
   * sign out. Bypasses the email/password lookup — useful for
   * driving auth state directly in tests without seeding.
   */
  setUser(auth: Auth, user: User | null): void {
    requireSandbox(auth, 'sandbox.setUser').backend.setCurrentUser(user);
  },

  /**
   * Install the popup/redirect resolver — the analog of browser
   * `getAuth` wiring `browserPopupRedirectResolver`. The host
   * (playground) sets this once; `signInWithPopup` / `signInWithRedirect`
   * then delegate the experience to it. Pass `null` to clear.
   *
   * Precedence at sign-in time: a per-call resolver arg wins, then this
   * injected one, then a one-shot `mockSignInResult`, else
   * `auth/argument-error`.
   */
  setAuthFlowResolver(auth: Auth, resolver: AuthFlowResolver | null): void {
    requireSandbox(auth, 'sandbox.setAuthFlowResolver').backend.setResolver(resolver);
  },

  /**
   * Snapshot every known identity (seeded + created), for a host
   * account-picker UI. Sandbox-only — no `firebase/auth` equivalent.
   */
  listIdentities(auth: Auth) {
    return requireSandbox(auth, 'sandbox.listIdentities').backend.listIdentities();
  },

  /**
   * Mint a sign-in credential for a host-driven flow — the account
   * picker's "pick existing" (`{providerId, uid}`) and "add account"
   * (`{providerId, spec}`) actions. Token + claims synthesis is
   * backend-owned (routed through the same token cache as every
   * other sign-in), replacing host-synthesized token strings.
   *
   * The credential does NOT sign anyone in — resolve the pending
   * `AuthFlowResolver` promise with it and the in-flight
   * `signInWithPopup` / `signInWithRedirect` completes the sign-in.
   */
  createSignInCredential(
    auth: Auth,
    request:
      | { providerId: string; uid: string }
      | { providerId: string; spec: SignInIdentitySpec },
  ): UserCredential {
    return requireSandbox(auth, 'sandbox.createSignInCredential')
      .backend.createSignInCredential(request);
  },

  /**
   * Pre-stage the result that the next `signInWithPopup` /
   * `signInWithCredential` call for the matching `providerId`
   * returns. The one-shot tier of the resolver precedence (used when no
   * resolver is injected) — consumed by the next sign-in call; stage
   * again for repeat tests.
   */
  mockSignInResult(auth: Auth, result: UserCredential): void {
    const backend = requireSandbox(auth, 'sandbox.mockSignInResult').backend;
    const providerId = result.providerId;
    if (!providerId) {
      throw new SandboxError(
        'invalid-argument',
        'sandbox.mockSignInResult: result.providerId is required so the next signInWithPopup / signInWithCredential call can match.',
      );
    }
    backend.setMockResult(providerId, result);
  },

  /**
   * Bulk-load test users for email/password lookup. Idempotent for
   * a given uid+email — re-seeding the same uid overwrites.
   */
  seedUsers(auth: Auth, users: ReadonlyArray<SeedUser>): void {
    requireSandbox(auth, 'sandbox.seedUsers').backend.seedUsers(users);
  },

  /**
   * Export the user DB in the exact shape {@link sandbox.seedUsers}
   * accepts — `exportUsers` → `seedUsers` round-trips losslessly (the
   * persistence substrate, the design rationale section 3c).
   * Provider-flow identities without a password export with a documented
   * sentinel; anonymous users are not exported (ephemeral by design).
   */
  exportUsers(auth: Auth): SeedUser[] {
    return requireSandbox(auth, 'sandbox.exportUsers').backend.exportUsers();
  },

  /**
   * Re-establish a signed-in session for an EXISTING identity — the
   * substrate behind web-storage session persistence at the host layer.
   * Fires auth-state listeners like a real restored session. Throws
   * `auth/user-not-found` for unknown uids, `auth/user-disabled` for
   * disabled accounts (a restore is a sign-in).
   */
  restoreSession(auth: Auth, uid: string): User {
    return requireSandbox(auth, 'sandbox.restoreSession').backend.restoreSession(uid);
  },

  /**
   * Mint a session identity WITHOUT signing it in globally — the
   * substrate for **per-connection identity** at the serve layer
   * (issue #754): one shared sandbox, N connections (tabs / clients),
   * each with its own authenticated session. Performs a real sign-in's
   * bookkeeping (provider record, `lastLoginAt`, a fresh token, the
   * `sign_in` activity event) but leaves `auth.currentUser`, the
   * auth-state listeners, and session persistence untouched.
   *
   * Returns the `User` plus the `AuthState` its data contexts should
   * carry — `getFirestore(sandbox.withAuth(session.state))` evaluates
   * rules exactly as a real sign-in would (`request.auth.uid` +
   * custom claims on `request.auth.token`).
   *
   * This is an AUTHENTIC session (credentials are validated / an
   * identity is really minted) — distinct from the rules-debugging
   * impersonation lens, which asserts a uid without authenticating.
   */
  mintSession(auth: Auth, request: MintSessionRequest): MintedSession {
    return requireSandbox(auth, 'sandbox.mintSession').backend.mintDetachedSession(request);
  },

  // ── User-admin surface (emulator-REST-shaped) ──────────────────────

  /**
   * Every user in the sandbox user DB (seeded, created,
   * signed-in-via-provider, anonymous) as {@link AuthUserRecord}s.
   * Snapshot — subscribe to changes via {@link sandbox.subscribeUsers}.
   */
  listUsers(auth: Auth): AuthUserRecord[] {
    return requireSandbox(auth, 'sandbox.listUsers').backend.listUsers();
  },

  /**
   * Create a user without signing them in (admin semantics — the
   * client-mirror `createUserWithEmailAndPassword` is the
   * signs-you-in variant). Throws `auth/uid-already-exists`,
   * `auth/email-already-in-use`, `auth/invalid-email`,
   * `auth/weak-password` on bad input.
   */
  createUser(auth: Auth, request: CreateUserRequest): AuthUserRecord {
    return requireSandbox(auth, 'sandbox.createUser').backend.createUser(request);
  },

  /**
   * Update a user. `undefined` fields untouched; `customClaims`
   * replaces the whole map; setting `disabled: true` blocks future
   * sign-ins with `auth/user-disabled` (active sessions continue —
   * same as prod until token revocation).
   */
  updateUser(auth: Auth, uid: string, update: UpdateUserRequest): AuthUserRecord {
    return requireSandbox(auth, 'sandbox.updateUser').backend.updateUser(uid, update);
  },

  /**
   * Update a user's PROFILE (`displayName` / `photoURL`) by uid — the
   * backend behind the served worker path's `updateProfile`. `undefined`
   * fields untouched; `null` clears. Returns the refreshed record; throws
   * `auth/user-not-found` for an unknown uid. (The client-facing
   * `updateProfile(user, …)` free function is the app-code surface; this is
   * the by-uid op the SharedWorker host calls.)
   */
  updateProfile(
    auth: Auth,
    uid: string,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): AuthUserRecord {
    return requireSandbox(auth, 'sandbox.updateProfile').backend.updateProfileByUid(uid, profile);
  },

  /** Delete a user record. Throws `auth/user-not-found` for unknown
   *  uids. Active sessions are not terminated (prod parity). */
  deleteUser(auth: Auth, uid: string): void {
    requireSandbox(auth, 'sandbox.deleteUser').backend.deleteUser(uid);
  },

  /** Drop every user record — the emulator's "delete all accounts". */
  clearUsers(auth: Auth): void {
    requireSandbox(auth, 'sandbox.clearUsers').backend.clearUsers();
  },

  /**
   * Subscribe to user-DB mutations (seed / create / update / delete /
   * clear / provider links / lastLoginAt bumps). Coarse contract: no
   * payload, no initial fire — re-list via {@link sandbox.listUsers}
   * in the callback.
   */
  subscribeUsers(auth: Auth, callback: () => void): Unsubscribe {
    return requireSandbox(auth, 'sandbox.subscribeUsers').backend.subscribeUsers(callback);
  },

  // ── Sign-in provider config (Authentication → Sign-in method toggles) ──

  /**
   * Every provider this sandbox has an explicit enablement for —
   * seeded defaults (`password`, `anonymous` — both `true`) plus
   * anything toggled via {@link sandbox.setAuthProviderConfig}. Every
   * OTHER providerId (`google.com`, a custom OAuth id, …) is disabled
   * until explicitly enabled.
   */
  getAuthProviderConfig(auth: Auth): Array<{ providerId: string; enabled: boolean }> {
    return requireSandbox(auth, 'sandbox.getAuthProviderConfig').backend.listProviderConfig();
  },

  /**
   * Enable/disable a sign-in provider. Gated at every provider entry
   * point of the ENFORCING backend (`signInWithPopup`/`signInWithRedirect`,
   * `signInWithCredential`, `createUserWithEmailAndPassword`/
   * `signInWithEmailAndPassword` for `'password'`, `signInAnonymously`
   * for `'anonymous'`) — disabling a provider makes the matching sign-in
   * call throw real Firebase's `auth/operation-not-allowed`, exactly
   * like flipping the toggle off in the real console. Survives
   * `enablePersistence` round-trips (rides the `auth` service's
   * snapshot alongside the user DB). A backend whose enforcement is
   * delegated ({@link sandbox.delegateProviderEnforcement}) does NOT
   * gate locally — the remote authority it fronts does.
   */
  setAuthProviderConfig(auth: Auth, providerId: string, enabled: boolean): void {
    requireSandbox(auth, 'sandbox.setAuthProviderConfig').backend.setProviderConfig(providerId, enabled);
  },

  /**
   * Assert a provider is enabled — throws `auth/operation-not-allowed`
   * (the exact gate every provider entry point uses) when it is off.
   * For hosts that ARE the enforcement authority for identities
   * resolved elsewhere: the served SharedWorker calls this before
   * accepting a page-resolved popup/redirect identity
   * (`auth.acceptIdentity`), so Studio's provider toggles gate served
   * OAuth sign-in at the shared backend, not at each page's UI shim.
   */
  assertAuthProviderEnabled(auth: Auth, providerId: string): void {
    requireSandbox(auth, 'sandbox.assertAuthProviderEnabled').backend.assertProviderEnabled(providerId);
  },

  /**
   * Delegate (or reclaim) THIS handle's provider-enablement gate to a
   * remote authority. Serve-layer wiring: in SharedWorker mode the
   * page-local sandbox is only the UI vehicle for popup/redirect
   * resolution — the worker's `auth.acceptIdentity` gate (against the
   * worker's own, undelegated config) is the real toggle enforcement —
   * so the served `firebase/auth` entry sets `true` on the in-page
   * handle to let the picker open regardless of local defaults. Do NOT
   * set this on a backend that is itself the authority.
   */
  delegateProviderEnforcement(auth: Auth, delegated: boolean): void {
    requireSandbox(auth, 'sandbox.delegateProviderEnforcement')
      .backend.setProviderEnforcementDelegated(delegated);
  },

  /**
   * Subscribe to provider-config mutations. Coarse contract: no
   * payload, no initial fire — re-read via
   * {@link sandbox.getAuthProviderConfig} in the callback (same shape
   * as {@link sandbox.subscribeUsers}).
   */
  subscribeAuthProviderConfig(auth: Auth, callback: () => void): Unsubscribe {
    return requireSandbox(auth, 'sandbox.subscribeAuthProviderConfig').backend.subscribeProviderConfig(callback);
  },
};

function requireSandbox(auth: Auth, name: string): SandboxTarget {
  const target = targetOf(auth);
  if (target.kind !== 'sandbox') {
    throw new SandboxError(
      'failed-precondition',
      `${name} is sandbox-only; this Auth handle is prod-backed.`,
    );
  }
  return target;
}
