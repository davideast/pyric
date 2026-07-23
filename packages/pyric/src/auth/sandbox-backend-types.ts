/**
 * Data shapes for the sandbox auth backend.
 *
 * Extracted verbatim from `sandbox-backend.ts` — the public request /
 * record types consumers reach through the barrel (`SeedUser`,
 * `MintSessionRequest`, `AuthUserRecord`, `CreateUserRequest`,
 * `UpdateUserRequest`, `ProviderUserInfo`, `SignInIdentitySpec`,
 * `MintedSession`, plus `NO_PASSWORD_SENTINEL`) and the internal
 * per-record / per-registration shapes the backend core owns
 * (`StoredUser`, `Registration`, `BeforeStateReg`, `Mutable`). No
 * behavior: type declarations plus one const sentinel.
 */

import type { AuthState } from 'pyric/sandbox';

import type { AuthObserver, User } from './types.js';

/** Strip `readonly` so a runtime-mutable `User`/`UserInfo` (fields are
 *  `readonly` at the type level but plain data at runtime) can be updated in
 *  place — used by `updateProfile` to reflect the change on held references. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Seed record for `sandbox.seedUsers`. */
/** Stand-in password for exported provider-flow identities that never had
 *  one — keeps `exportUsers` → `seedUsers` round-trips lossless without
 *  widening the `SeedUser` shape. Not a secret: sandbox-only. */
export const NO_PASSWORD_SENTINEL = '__pyric_no_password__';

export interface SeedUser {
  uid: string;
  email: string;
  password: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
  /** Originating provider for this identity (e.g. `'google.com'`).
   *  Defaults to `'password'` — the natural provider for a record
   *  seeded with an email + password. A host seeding popup-flow
   *  identities passes the real provider so `listIdentities` /
   *  `IdTokenResult.signInProvider` label them correctly. */
  providerId?: string;
}

/**
 * Request for {@link SandboxBackend.mintDetachedSession} — one variant
 * per client sign-in shape, plus `uid` for existing identities
 * (session restore, provider-bridge accept).
 */
export type MintSessionRequest =
  | { kind: 'anonymous' }
  | { kind: 'password'; email: string; password: string }
  | { kind: 'createPassword'; email: string; password: string }
  | { kind: 'uid'; uid: string };

/** A minted per-connection session: the `User` plus the {@link AuthState}
 *  its data contexts should carry (`sandbox.withAuth(state)`). */
export interface MintedSession {
  user: User;
  state: NonNullable<AuthState>;
}

/**
 * A single listener registration. One per `subscribe()` call — the
 * same observer fn subscribed twice produces two records (matching
 * upstream's array-backed observer list, where duplicates are allowed
 * and removed one at a time by index).
 */
export interface Registration {
  observer: AuthObserver;
  /** Whether this registration has delivered at least once. Gates the
   *  microtask initial-fire so a synchronous `fanOut` between subscribe
   *  and the microtask (the mount-time `subscribe(); signIn()` race
   *  prod can't exhibit) doesn't produce a duplicate same-value fire. */
  hasFired: boolean;
  /** Last value this registration delivered. Combined with `hasFired`,
   *  lets the initial-fire microtask skip ONLY when this specific
   *  registration already saw the current value synchronously. */
  lastValue: User | null;
}

/**
 * A single `beforeAuthStateChanged` registration. `active: false` marks
 * an unregistered slot — swapped to a no-op in place (see
 * {@link SandboxBackend.beforeStateSubs}) rather than spliced, so an
 * unsubscribe from inside a running middleware pass doesn't shift the
 * indices the pass is still iterating.
 */
export interface BeforeStateReg {
  callback: (user: User | null) => void | Promise<void>;
  onAbort?: () => void;
  active: boolean;
}

/** One linked provider on a stored user. Emulator-shaped (the
 *  Identity Toolkit `providerUserInfo` array) — an array rather than
 *  a single string so account linking can extend it later. */
export interface ProviderUserInfo {
  providerId: string;
}

/** "Add account" field set for {@link SandboxBackend.createSignInCredential}
 *  — mirrors the emulator's add-user form (`customAttributes` →
 *  `customClaims`). */
export interface SignInIdentitySpec {
  /** Defaults to an opaque generated uid. */
  uid?: string;
  email: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
}

/** Internal record in the in-memory user DB. `email`/`password` are
 *  null for identities that never had them (anonymous users,
 *  popup-only identities recorded at sign-in time). */
export interface StoredUser {
  uid: string;
  email: string | null;
  password: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  photoUrl: string | null;
  customClaims: Record<string, unknown>;
  isAnonymous: boolean;
  /** Linked providers. Empty for anonymous users (matches the
   *  emulator: anonymous accounts carry no providerUserInfo; their
   *  provider surfaces as `sign_in_provider: 'anonymous'` on the
   *  token instead). */
  providerUserInfo: ProviderUserInfo[];
  /** Disabled accounts reject every sign-in attempt with
   *  `auth/user-disabled` (faithful to prod). */
  disabled: boolean;
  emailVerified: boolean;
  /** ISO timestamp — when the record entered the user DB. */
  createdAt: string;
  /** ISO timestamp of the most recent sign-in, or null if this
   *  identity never signed in. */
  lastLoginAt: string | null;
}

/**
 * Public per-user record for the user-admin surface
 * (`sandbox.listUsers` & co.) — emulator-REST-shaped (Identity
 * Toolkit `accounts:lookup` field names, ISO timestamps).
 */
export interface AuthUserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  photoUrl: string | null;
  customClaims: Record<string, unknown>;
  providerUserInfo: ProviderUserInfo[];
  isAnonymous: boolean;
  disabled: boolean;
  emailVerified: boolean;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp, or null if the identity never signed in. */
  lastLoginAt: string | null;
}

/** `sandbox.createUser` request. Everything optional except that a
 *  `password` requires an `email` to be useful for sign-in. */
export interface CreateUserRequest {
  /** Defaults to a generated `user-<N>` uid. */
  uid?: string;
  email?: string;
  password?: string;
  displayName?: string;
  phoneNumber?: string;
  photoUrl?: string;
  customClaims?: Record<string, unknown>;
  disabled?: boolean;
  emailVerified?: boolean;
  /** Linked OAuth providers to create the user with (dedup by
   *  providerId; multiple providers per user are supported). Same
   *  rules as {@link UpdateUserRequest.providerUserInfo}: `password`
   *  is credential-derived (send `password` to link it) and
   *  `anonymous` is token-level — neither can be forged here. */
  providerUserInfo?: ProviderUserInfo[];
}

/** `sandbox.updateUser` request — `undefined` fields are left
 *  untouched; `displayName: null` clears it. `customClaims` replaces
 *  the whole map (admin `setCustomUserClaims` semantics). */
export interface UpdateUserRequest {
  displayName?: string | null;
  email?: string;
  password?: string;
  customClaims?: Record<string, unknown>;
  disabled?: boolean;
  emailVerified?: boolean;
  /** REPLACES the user's linked OAuth providers (dedup by providerId;
   *  multiple providers per user are supported — the record's
   *  `providerUserInfo` is an array precisely for account linking).
   *  The `password` entry is credential-derived and managed by the
   *  backend: it survives the replacement while the user has a
   *  password and cannot be linked through this field; `anonymous`
   *  is a token-level provider, never a linked entry. */
  providerUserInfo?: ProviderUserInfo[];
}
