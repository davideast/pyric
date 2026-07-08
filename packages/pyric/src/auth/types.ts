/**
 * Public types for `pyric/auth`. Backend-opaque shapes that mirror
 * `firebase/auth`'s modular surface at the type level. Sandbox and
 * prod targets both satisfy these interfaces — consumer code stays
 * agnostic.
 *
 * Where the upstream SDK exposes deeper fields than the dual-target
 * surface can guarantee (provider data internals, multi-factor
 * extensions, etc.), the pyric type is a *subset* — fields the
 * sandbox can synthesize and the prod backend already provides. Code
 * that touches only the subset works across both.
 */

import type { Target } from './target.js';

/** Branded handle for {@link Auth}. Set on every handle returned by
 *  {@link getAuth}; consumers don't read it. Exposed only so the
 *  dispatch helpers in this package can recover routing without a
 *  WeakMap lookup. */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/auth/target');

/**
 * Result of `getIdTokenResult()`. Mirrors the `firebase/auth` shape.
 *
 * On the sandbox backend `token` is an opaque sandbox-issued string
 * with a recognizable prefix (`sandbox-id-token-`) — NOT a JWT and
 * NOT cryptographically signed. `claims` echoes the user's
 * `customClaims` (from `sandbox.seedUsers`) plus a small set of
 * synthesized standard claims (`sub`, `aud`, `iss`). Expiration is
 * set far in the future since the sandbox has no refresh story.
 */
export interface IdTokenResult {
  /** Opaque token string. Sandbox: `sandbox-id-token-<uid>-<hash>`.
   *  Prod: a real Firebase ID token (JWT). */
  token: string;
  /** Custom + standard claims. Same map seen by the rules engine as
   *  `request.auth.token.*`. */
  claims: Record<string, unknown>;
  /** ISO string. Sandbox: far-future. */
  expirationTime: string;
  /** ISO string. */
  issuedAtTime: string;
  /** ISO string — when the user last *signed in* (not when the token
   *  was last refreshed). */
  authTime: string;
  /**
   * Provider of the current sign-in session — `'password'`,
   * `'anonymous'`, `'google.com'`, etc., or `null` when unknown.
   * Mirrors `firebase/auth`'s `IdTokenResult.signInProvider` (prod
   * derives it from the JWT's `firebase.sign_in_provider` claim; the
   * sandbox synthesizes the same claim).
   *
   * Optional (`?`) for now: external `User` implementations built
   * before this field existed (the playground's helper-minted users,
   * until Track B's lockstep swap lands) omit it. The sandbox backend
   * always populates it. Tighten to required once all `User` minting
   * is backend-owned.
   */
  signInProvider?: string | null;
}

/**
 * Per-provider profile info — mirror of `firebase/auth`'s `UserInfo`.
 * Each entry in {@link User.providerData} describes one linked provider.
 */
export interface UserInfo {
  /** Display name from this provider, or `null`. */
  readonly displayName: string | null;
  /** Email from this provider, or `null`. */
  readonly email: string | null;
  /** E.164 phone number from this provider, or `null`. */
  readonly phoneNumber: string | null;
  /** Profile photo URL from this provider, or `null`. */
  readonly photoURL: string | null;
  /** Provider id (e.g. `'password'`, `'google.com'`). */
  readonly providerId: string;
  /** The user's id as known to this provider. */
  readonly uid: string;
}

/**
 * The signed-in user. Subset of `firebase/auth`'s `User` interface —
 * fields the sandbox can synthesize and that the prod backend
 * already provides on a real `User`.
 *
 * The heavier `User` surface the sandbox does NOT model (`metadata`,
 * `refreshToken`, `tenantId`, `reload()`, `delete()`, `toJSON()`) is
 * documented in `docs/auth/COMPAT.md` / the deny-list rather than
 * synthesized — see AUTH-GAP.
 */
export interface User {
  /** Firebase UID — globally unique per project. Sandbox: minted by
   *  `signInAnonymously` or supplied via `seedUsers`. */
  readonly uid: string;
  /** Email address, or `null` for anonymous users / providers that
   *  didn't supply one. */
  readonly email: string | null;
  /** Whether the email has been verified. Sandbox: `false` unless the
   *  seeded/mock user set it (no verification flow). Optional on the
   *  type so host helpers that synthesize a partial `User` aren't forced
   *  to specify it; the sandbox + prod backends always populate it. */
  readonly emailVerified?: boolean;
  /** Display name, or `null` if none. */
  readonly displayName: string | null;
  /** Profile photo URL, or `null`. Optional on the type (see
   *  {@link emailVerified}); always populated by the backends. */
  readonly photoURL?: string | null;
  /** E.164 phone number, or `null`. Optional on the type; always
   *  populated by the backends. */
  readonly phoneNumber?: string | null;
  /** True iff this user signed in via `signInAnonymously`. */
  readonly isAnonymous: boolean;
  /** The aggregate provider id (`'firebase'` for a real `User`;
   *  per-provider ids live in {@link providerData}). Optional on the
   *  type; always populated by the backends. */
  readonly providerId?: string;
  /** One {@link UserInfo} per linked provider. Sandbox synthesizes a
   *  single entry from the user's own fields for non-anonymous users;
   *  empty for anonymous. Optional on the type; always populated by the
   *  backends. */
  readonly providerData?: UserInfo[];

  /**
   * Get the user's ID token, refreshing it if needed.
   *
   * Sandbox: returns the cached opaque token; with
   * `forceRefresh: true` mints a fresh token, caches it, and fires
   * `onIdTokenChanged` listeners (matches prod — oracle:
   * `scripts/oracle/observations/auth-getidtoken-force-refresh.json`
   * and `…/auth-onidtokenchanged-force-refresh.json`).
   * Prod: delegates to `firebase/auth`'s `User.getIdToken(forceRefresh)`.
   */
  getIdToken(forceRefresh?: boolean): Promise<string>;
  /** Get the full ID token + claims. See {@link IdTokenResult}. */
  getIdTokenResult(forceRefresh?: boolean): Promise<IdTokenResult>;
}

/**
 * Result of every sign-in method. Mirrors `firebase/auth`.
 *
 * `operationType` is `'signIn'` for fresh sign-ins, `'reauthenticate'`
 * for re-auth flows (not implemented in v0; field present for type
 * parity), `'link'` for link flows (also v0 deny-list).
 */
export interface UserCredential {
  user: User;
  providerId: string | null;
  operationType: 'signIn' | 'reauthenticate' | 'link';
}

/**
 * Auth credential — opaque token from a sign-in flow. Used by
 * `signInWithCredential(auth, credential)`. The sandbox does not
 * verify these; they're treated as bearer markers paired with a
 * `mockSignInResult` pre-stage.
 */
export interface AuthCredential {
  /** Provider identifier (e.g. `'google.com'`, `'password'`). */
  providerId: string;
  /** Sign-in method identifier (often equal to `providerId`). */
  signInMethod: string;
}

/**
 * What a popup/redirect sign-in flow needs to know about the request.
 * Mirrors the params `firebase/auth` hands its emulator widget
 * (`providerId`, `authType`, `scopes`, `customParameters` — see
 * upstream `core/util/handler.ts`), so a resolver implementation has
 * the same inputs the real flow does.
 */
export interface AuthFlowRequest {
  /** e.g. `'google.com'`, `'github.com'`, or a generic `OAuthProvider` id. */
  providerId: string;
  /** Why the popup/redirect opened. v0 only drives `'signIn'`; the
   *  others exist for parity with reauth/link flows. */
  authType: 'signIn' | 'reauth' | 'link';
  /** OAuth scopes the provider requested (`addScope`). Sandbox-opaque. */
  scopes?: string[];
  /** Provider custom parameters (`setCustomParameters`). Sandbox-opaque. */
  customParameters?: Record<string, unknown>;
}

/**
 * Pluggable popup/redirect resolver — pyric's analog of
 * `firebase/auth`'s `PopupRedirectResolver`. The SDK stays UI-free and
 * delegates the *experience* to whatever implements this: a playground
 * modal, a headless test fixture, a CLI prompt. One resolver serves all
 * three flows.
 *
 * Configured the same three ways the upstream resolver is: passed
 * per-call to `signInWithPopup` / `signInWithRedirect`, injected once
 * via `sandbox.setAuthFlowResolver` (the analog of browser `getAuth`
 * wiring `browserPopupRedirectResolver`), or installed implicitly as a
 * one-shot by `sandbox.mockSignInResult`.
 *
 * Implementations reject with `auth/popup-closed-by-user` when the user
 * dismisses the experience — matches `firebase/auth`.
 */
export interface AuthFlowResolver {
  /** Resolve a `signInWithPopup` flow to a credential. */
  openPopup(req: AuthFlowRequest): Promise<UserCredential>;
  /** Resolve a `signInWithRedirect` flow. In a real browser the redirect
   *  navigates away and the credential surfaces on return; the sandbox has
   *  no navigation, so this resolves inline to the credential and the SDK
   *  stashes it for the next `getRedirectResult`. */
  openRedirect(req: AuthFlowRequest): Promise<UserCredential>;
}

/**
 * Observer shape accepted by `onAuthStateChanged` / `onIdTokenChanged`.
 * Mirrors `firebase/auth`'s `NextOrObserver<User | null>`.
 */
export type AuthObserver =
  | ((user: User | null) => void)
  | {
    next?: (user: User | null) => void;
    error?: (err: Error) => void;
    complete?: () => void;
  };

/** Returned by `onAuthStateChanged` / `onIdTokenChanged`. */
export type Unsubscribe = () => void;

/**
 * Hidden brand stamped non-enumerably on every {@link User} object so the
 * top-level `updateProfile(user, …)` free function can dispatch to the
 * right backend WITHOUT an `auth` handle in scope (matching
 * `firebase/auth`'s `updateProfile(user, profile)` signature, which takes
 * only the user). Consumers never read it.
 */
export const USER_INTERNAL: unique symbol = Symbol('pyric.user.internal');

/**
 * Backend dispatch contract carried on a {@link User} via {@link USER_INTERNAL}.
 * The sandbox backend stamps an implementation that mutates the stored record
 * + the in-memory user in place; the prod backend stamps one that delegates
 * to the real `firebase/auth.updateProfile`.
 */
export interface UserInternal {
  updateProfile(profile: {
    displayName?: string | null;
    photoURL?: string | null;
  }): Promise<void>;
}

/**
 * Opaque marker for `setPersistence`. Sandbox treats these as
 * no-ops; prod hands them to `firebase/auth.setPersistence` which
 * looks at the `type` field at runtime.
 */
export interface Persistence {
  readonly type: 'SESSION' | 'LOCAL' | 'NONE';
}

/**
 * Hidden brand on every {@link Auth} handle. Carries the dispatch
 * target (sandbox vs prod). Consumers don't read it.
 */
export interface Auth {
  /** Currently signed-in user, or `null`. Snapshot value — read
   *  through `onAuthStateChanged` for live updates. */
  readonly currentUser: User | null;
  /** Sign the current user out. Method form of the free `signOut(auth)`
   *  function — `firebase/auth`'s `Auth` exposes both, so consumer code
   *  written as `auth.signOut()` works unchanged (AUTH-GAP). */
  signOut(): Promise<void>;
  /** Internal — discriminates sandbox vs prod backend. */
  readonly [TARGET_SYMBOL]: Target;
}
