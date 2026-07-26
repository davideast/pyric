/**
 * Public types for `pyric/auth`. Sandbox-owned shapes that mirror
 * `firebase/auth`'s modular surface at the type level, so canonical
 * consumer imports keep the same source shape when package resolution
 * selects the sandbox.
 *
 * Where the upstream SDK exposes deeper fields than the sandbox can
 * guarantee (provider data internals, multi-factor extensions, etc.),
 * the pyric type is a *subset* of the Firebase type.
 */

import type { Target } from './target.js';
import type { FirebaseApp } from '../app/types.js';

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
  /** Opaque sandbox token string: `sandbox-id-token-<uid>-<hash>`. */
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
   * Mirrors `firebase/auth`'s `IdTokenResult.signInProvider`; the
   * sandbox synthesizes the same `firebase.sign_in_provider` claim.
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
 * The signed-in user. Subset of `firebase/auth`'s `User` interface
 * containing the fields the sandbox can synthesize faithfully.
 *
 * The heavier `User` surface the sandbox does NOT model (`metadata`,
 * `refreshToken`, `tenantId`, `reload()`, `delete()`, `toJSON()`) is
 * intentionally not synthesized; its absence remains visible in the public
 * type census rather than being hidden behind placeholder values.
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
   *  to specify it; the sandbox backend always populates it. */
  readonly emailVerified?: boolean;
  /** Display name, or `null` if none. */
  readonly displayName: string | null;
  /** Profile photo URL, or `null`. Optional on the type (see
   *  {@link emailVerified}); always populated by the sandbox backend. */
  readonly photoURL?: string | null;
  /** E.164 phone number, or `null`. Optional on the type; always
   *  populated by the sandbox backend. */
  readonly phoneNumber?: string | null;
  /** True iff this user signed in via `signInAnonymously`. */
  readonly isAnonymous: boolean;
  /** The aggregate provider id (`'firebase'` for a real `User`;
   *  per-provider ids live in {@link providerData}). Optional on the
   *  type; always populated by the sandbox backend. */
  readonly providerId?: string;
  /** One {@link UserInfo} per linked provider. Sandbox synthesizes a
   *  single entry from the user's own fields for non-anonymous users;
   *  empty for anonymous. Optional on the type; always populated by the
   *  sandbox backend. */
  readonly providerData?: UserInfo[];

  /**
   * Get the user's ID token, refreshing it if needed.
   *
   * Sandbox: returns the cached opaque token; with
   * `forceRefresh: true` mints a fresh token, caches it, and fires
   * `onIdTokenChanged` listeners (matches prod — oracle:
   * `packages/conformance/observations/auth/auth-getidtoken-force-refresh.json`
   * and `…/auth-onidtokenchanged-force-refresh.json`).
   */
  getIdToken(forceRefresh?: boolean): Promise<string>;
  /** Get the full ID token + claims. See {@link IdTokenResult}. */
  getIdTokenResult(forceRefresh?: boolean): Promise<IdTokenResult>;
}

/**
 * Result of every sign-in method. Mirrors `firebase/auth`.
 *
 * `operationType` discriminates what produced it: `'signIn'` for a fresh
 * sign-in (including `createUserWithEmailAndPassword` — oracle-pinned),
 * `'link'` for `linkWith*`, `'reauthenticate'` for `reauthenticateWith*`.
 */
export interface UserCredential {
  user: User;
  providerId: string | null;
  operationType: 'signIn' | 'reauthenticate' | 'link';
  /**
   * What `getAdditionalUserInfo(cred)` returns. Carried on the credential
   * rather than derived, because `isNewUser` is a fact only the flow that
   * MINTED the credential knows: `createUserWithEmailAndPassword` created
   * the identity, `signInWithEmailAndPassword` did not, and nothing about
   * the finished credential can tell them apart after the fact.
   *
   * Underscore-prefixed and optional: it is not part of the shape a host
   * or a test fixture has to synthesize (a credential without it degrades
   * honestly — see `getAdditionalUserInfo`).
   */
  _additionalUserInfo?: {
    readonly isNewUser: boolean;
    readonly profile: Record<string, unknown> | null;
    readonly providerId: string | null;
    readonly username?: string | null;
  };
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
 * Hidden brand stamped non-enumerably on every sandbox {@link User} object
 * so the top-level `updateProfile(user, …)` free function can reach the
 * owning sandbox WITHOUT an `auth` handle in scope (matching
 * `firebase/auth`'s `updateProfile(user, profile)` signature, which takes
 * only the user). Consumers never read it.
 */
export const USER_INTERNAL: unique symbol = Symbol('pyric.user.internal');

/**
 * Sandbox operation contract carried on a {@link User} via
 * {@link USER_INTERNAL}. The owning backend stamps an implementation that
 * mutates the stored record and the in-memory user in place.
 */
export interface UserInternal {
  updateProfile(profile: {
    displayName?: string | null;
    photoURL?: string | null;
  }): Promise<void>;
  /** Backend for the top-level `deleteUser(user)` — removes the account
   *  from the store and signs the user out if they are current. */
  delete(): Promise<void>;
  /** Backend for the top-level `updateEmail(user, newEmail)` — mutates the
   *  stored record's email (and this user in place). */
  updateEmail(newEmail: string): Promise<void>;
  /** Backend for the top-level `updatePassword(user, newPassword)` — sets
   *  the stored password (verified on the next sign-in). */
  updatePassword(newPassword: string): Promise<void>;
  /** Backend for the top-level `reload(user)` — re-reads the stored record
   *  into this user object in place. */
  reload(): Promise<void>;
  /**
   * The sandbox target this user came from — the same brand
   * {@link Auth} carries, recovered from the USER alone.
   *
   * Needed because a whole family of `firebase/auth` APIs takes a `User`
   * and NO `Auth` handle (`sendEmailVerification(user)`,
   * `linkWithCredential(user, cred)`, `unlink(user, id)`,
   * `reauthenticateWithCredential(user, cred)`, …). Those functions still
   * have to reach the sandbox that owns the user, and the user object is
   * the only thing they are given. The routing information therefore rides
   * on the user.
   */
  target: Target;
}

/**
 * Opaque marker for `setPersistence`. The sandbox records the selected
 * session storage mode from the `type` field.
 *
 * `'COOKIE'` is upstream's fourth type (`browserCookiePersistence`, for
 * SSR) — the union matches `firebase/auth`'s `Persistence.type` exactly.
 */
export interface Persistence {
  readonly type: 'SESSION' | 'LOCAL' | 'NONE' | 'COOKIE';
}

/**
 * Hidden brand on every {@link Auth} handle. Carries its owning sandbox
 * target. Consumers don't read it.
 */
export interface Auth {
  readonly app?: FirebaseApp;
  /** Currently signed-in user, or `null`. Snapshot value — read
   *  through `onAuthStateChanged` for live updates. */
  readonly currentUser: User | null;
  /** Sign the current user out. Method form of the free `signOut(auth)`
   *  function — `firebase/auth`'s `Auth` exposes both, so consumer code
   *  written as `auth.signOut()` works unchanged (AUTH-GAP). */
  signOut(): Promise<void>;
  /** Internal — identifies the owning sandbox backend. */
  readonly [TARGET_SYMBOL]: Target;
}

/** Auth handle returned by Firebase-shaped app overloads. */
export type AppAuth = Auth & { readonly app: FirebaseApp };

export type ConfirmationResult = {
  readonly verificationId: string;
  confirm(verificationCode: string): Promise<UserCredential>;
};
export type MultiFactorAssertion = { readonly factorId: string; [key: string]: unknown };
export type MultiFactorError = AuthError & { readonly customData?: { readonly resolver?: MultiFactorResolver } };
export type MultiFactorInfo = { readonly uid: string; readonly displayName?: string | null; readonly factorId: string; readonly enrollmentTime?: string };
export type MultiFactorResolver = {
  readonly session: MultiFactorSession;
  readonly hints: ReadonlyArray<MultiFactorInfo>;
  resolveSignIn(assertion: MultiFactorAssertion): Promise<UserCredential>;
};
export type MultiFactorSession = { readonly id: string };
export type MultiFactorUser = {
  readonly enrolledFactors: ReadonlyArray<MultiFactorInfo>;
  getSession(): Promise<MultiFactorSession>;
  enroll(assertion: MultiFactorAssertion, displayName?: string | null): Promise<void>;
  unenroll(target: string | MultiFactorInfo): Promise<void>;
};

export class PhoneAuthCredential {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'verificationId' in instance && 'verificationCode' in instance);
  }
  constructor(public readonly verificationId: string, public readonly verificationCode: string) {}
}

export class PhoneAuthProvider {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'providerId' in instance && (instance as any).providerId === 'phone');
  }
  static credential(verificationId: string, verificationCode: string): PhoneAuthCredential {
    return { providerId: 'phone', signInMethod: 'phone', verificationId, verificationCode } as unknown as PhoneAuthCredential;
  }
}

export type PhoneInfoOptions = PhoneSingleFactorInfoOptions | PhoneMultiFactorSignInInfoOptions | PhoneMultiFactorEnrollInfoOptions;
export type PhoneMultiFactorAssertion = MultiFactorAssertion & { readonly factorId: 'phone' };
export type PhoneMultiFactorEnrollInfoOptions = { readonly phoneNumber: string; readonly session: MultiFactorSession };

export class PhoneMultiFactorGenerator {
  static [Symbol.hasInstance](instance: unknown): boolean { return Boolean(instance && typeof instance === 'object' && 'factorId' in instance && (instance as any).factorId === 'phone'); }
  static FACTOR_ID = 'phone' as const;
  static assertion(credential: PhoneAuthCredential): PhoneMultiFactorAssertion { return { factorId: 'phone', credential } as PhoneMultiFactorAssertion; }
}

export type PhoneMultiFactorInfo = MultiFactorInfo & { readonly factorId: 'phone'; readonly phoneNumber: string };
export type PhoneMultiFactorSignInInfoOptions = { readonly session: MultiFactorSession; readonly phoneInfo: string };
export type PhoneSingleFactorInfoOptions = { readonly phoneNumber: string };
export type RecaptchaParameters = { readonly callback?: (token: string) => void; readonly 'expired-callback'?: () => void; readonly size?: 'normal' | 'compact' | 'invisible'; readonly badge?: 'bottomright' | 'bottomleft' | 'inline'; readonly tabindex?: number };

export class RecaptchaVerifier {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'verify' in instance && 'render' in instance && 'clear' in instance);
  }
  constructor(public readonly authInstance: Auth | string, public readonly container: string | unknown, public readonly parameters?: RecaptchaParameters) {}
  async verify(): Promise<string> {
    if (this.parameters?.callback && typeof this.parameters.callback === 'function') {
      this.parameters.callback('test-recaptcha-token-mock-0000');
    }
    return 'test-recaptcha-token-mock-0000';
  }
  async render(): Promise<number> { return 0; }
  clear(): void {}
}

export type TotpMultiFactorAssertion = MultiFactorAssertion & { readonly factorId: 'totp' };
export type TotpMultiFactorInfo = MultiFactorInfo & { readonly factorId: 'totp' };

export class TotpSecret {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'secretKey' in instance && 'generateQrCodeUrl' in instance);
  }
  constructor(public readonly secretKey: string, public readonly hashingAlgorithm: string, public readonly codeIntervalSeconds: number, public readonly codeLength: number) {}
  generateQrCodeUrl(accountName: string, issuer: string): string {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${this.secretKey}&issuer=${encodeURIComponent(issuer)}`;
  }
}

export class TotpMultiFactorGenerator {
  static [Symbol.hasInstance](instance: unknown): boolean { return Boolean(instance && typeof instance === 'object' && 'factorId' in instance && (instance as any).factorId === 'totp'); }
  static FACTOR_ID = 'totp' as const;
  static generateSecret(_session: MultiFactorSession): Promise<TotpSecret> {
    return Promise.resolve(new TotpSecret('JBSWY3DPEHPK3PXP', 'SHA1', 30, 6));
  }
  static assertionForEnrollment(secret: TotpSecret, otpCode: string): TotpMultiFactorAssertion {
    return { factorId: 'totp', secret, otpCode } as TotpMultiFactorAssertion;
  }
  static assertionForSignIn(enrollmentId: string, otpCode: string): TotpMultiFactorAssertion {
    return { factorId: 'totp', enrollmentId, otpCode } as TotpMultiFactorAssertion;
  }
}

export const FactorId = { PHONE: 'phone', TOTP: 'totp' } as const;
export type FactorId = (typeof FactorId)[keyof typeof FactorId];

export type ApplicationVerifier = { readonly type: string; verify(): Promise<string> };
export interface AuthError extends Error { readonly code: string; readonly customData?: Record<string, unknown> }
export type AuthSettings = { readonly appVerificationDisabledForTesting?: boolean };
export type Config = Record<string, unknown>;
export type CustomParameters = Record<string, string>;
export type Dependencies = Record<string, unknown>;
export type EmulatorConfig = { readonly url: string };
export type OAuthCredentialOptions = { readonly idToken?: string; readonly accessToken?: string; readonly rawNonce?: string };
export type ParsedToken = Record<string, unknown>;
export type PopupRedirectResolver = { readonly _resolverType: string };
export type CompleteFn = () => void;
export type ErrorFn = (error: AuthError) => void;
export type NextFn<T> = (value: T) => void;
export type NextOrObserver<T> = NextFn<T> | { next?: NextFn<T>; error?: ErrorFn; complete?: CompleteFn };
export type ReactNativeAsyncStorage = Record<string, unknown>;
export type UserMetadata = { readonly creationTime?: string; readonly lastSignInTime?: string };
export type UserProfile = { readonly displayName?: string | null; readonly photoURL?: string | null };
