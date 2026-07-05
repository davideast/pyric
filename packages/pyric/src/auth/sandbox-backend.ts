/**
 * Sandbox backend for `@pyric/auth`.
 *
 * Owns four pieces of per-sandbox state:
 *   1. In-memory user database — emails / passwords / customClaims
 *      seeded via `sandbox.seedUsers(auth, …)` plus accounts created
 *      through `createUserWithEmailAndPassword`.
 *   2. Listener registries — one for `onAuthStateChanged`, one for
 *      `onIdTokenChanged`. Both fire on user change; the
 *      `onIdTokenChanged` registry ALSO fires on a forced ID-token
 *      refresh (matches prod — see oracle observation
 *      `auth-onidtokenchanged-force-refresh.json`).
 *   3. Mock-result registry — pre-staged `UserCredential`s consumed by
 *      `signInWithPopup` / `signInWithCredential`. Keyed by
 *      `providerId`; one slot per provider.
 *   4. Token cache — current ID token string + IdTokenResult per uid.
 *      A fresh token is minted on each setCurrentUser transition into
 *      a non-null user (new session = new token) and on each
 *      `getIdToken(forceRefresh=true)`. Subsequent
 *      `getIdToken(false)` reads return the cached token (matches
 *      prod — see `auth-getidtoken-force-refresh.json`).
 *
 * The "current user" itself lives on `sandbox.currentUser`. We don't
 * shadow it — the source of truth is the sandbox so future
 * `getFirestore(sandbox)` overloads (deferred follow-up PR) can read
 * the same value per-call.
 *
 * `signInAnonymously` / `signInWithEmailAndPassword` / `signOut` /
 * `sandbox.setUser` all flow through {@link setCurrentUser}, which
 * writes `sandbox.currentUser` and fans out to both listener
 * registries. The sandbox's own `currentUser` setter is idempotent,
 * so calling it with the same identity twice is a no-op.
 */

import { FirebaseError } from 'firebase/app';

import type { AuthState, Sandbox } from 'pyric/sandbox';
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';

import {
  USER_INTERNAL,
  type AuthFlowResolver,
  type AuthObserver,
  type IdTokenResult,
  type Unsubscribe,
  type User,
  type UserCredential,
  type UserInfo,
} from './types.js';

/** Strip `readonly` so a runtime-mutable `User`/`UserInfo` (fields are
 *  `readonly` at the type level but plain data at runtime) can be updated in
 *  place — used by `updateProfile` to reflect the change on held references. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
interface Registration {
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
  /** Defaults to `'<providerId>:<email>'`. */
  uid?: string;
  email: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
}

/** Internal record in the in-memory user DB. `email`/`password` are
 *  null for identities that never had them (anonymous users,
 *  popup-only identities recorded at sign-in time). */
interface StoredUser {
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
}

/**
 * Per-sandbox backend state. One instance per `getAuth(sandbox)` —
 * memoized so repeat calls return the same backing store (matches
 * `firebase/auth`'s `getAuth(app)` idempotency).
 */
export class SandboxBackend {
  /** Email → stored user. Lowercase keys so lookups are case-
   *  insensitive (matches upstream). */
  private readonly usersByEmail = new Map<string, StoredUser>();
  /** UID → stored user. Lets `setUser` resolve customClaims for an
   *  arbitrary uid without scanning the email index. */
  private readonly usersByUid = new Map<string, StoredUser>();

  /** onAuthStateChanged registrations. Array, NOT a Set, so duplicate
   *  observer functions register independently — upstream backs each
   *  registry with an array (`util/src/subscribe.ts:191` pushes; dups
   *  allowed) and `unsubscribeOne(i)` removes by *index*, so the same
   *  fn subscribed twice fires twice and one unsubscribe removes one
   *  registration (AUTH-B4). Each record carries its own initial-fire
   *  bookkeeping so a shared per-observer dedup can't suppress a
   *  resubscribe or a second registration of the same fn (AUTH-B3). */
  private readonly authStateSubs: Registration[] = [];
  /** onIdTokenChanged registrations. Same array semantics. */
  private readonly idTokenSubs: Registration[] = [];
  /** `subscribeUsers` subscribers — coarse "user DB changed"
   *  callbacks; listeners re-list via `listUsers`. */
  private readonly userDbSubs = new Set<() => void>();
  /** Monotonic uid counter for `createUser` calls without a uid. */
  private nextAdminUserId = 1;

  /** Pre-staged sign-in results, keyed by providerId. The one-shot tier
   *  of the popup/redirect resolver precedence (see `index.ts`
   *  `signInWithPopup`): consumed when no resolver is injected, so
   *  headless conformance fixtures stay deterministic. */
  private readonly mockResults = new Map<string, UserCredential>();

  /** Injected popup/redirect resolver — the analog of browser
   *  `getAuth` wiring `browserPopupRedirectResolver`. Null until a host
   *  (the playground) installs one via `sandbox.setAuthFlowResolver`. */
  private resolver: AuthFlowResolver | null = null;

  /** Pending `getRedirectResult` payload — set by `signInWithRedirect`,
   *  returned-and-cleared by `getRedirectResult` (one-shot, matches prod). */
  private redirectResult: UserCredential | null = null;

  /** Monotonic uid counter for anonymous users. */
  private nextAnonymousId = 1;

  /** Underlying sandbox — written to on every sign-in/out. */
  private readonly sandbox: Sandbox;
  /** Cached `User` for `auth.currentUser` snapshots. Recomputed when
   *  the sandbox's currentUser changes; null on signed-out. */
  private cachedUser: User | null = null;

  /** The uid `onAuthStateChanged` was last notified with. Mirrors
   *  upstream's `lastNotifiedUid` (`auth_impl.ts:720`): auth-state only
   *  re-fires when this changes, so a same-uid profile-shape change or a
   *  same-uid re-sign-in does NOT re-fire auth-state (AUTH-B7). */
  private lastNotifiedUid: string | null = null;

  /** True while {@link setCurrentUser} is driving a transition through
   *  the sandbox setter. The synchronous `onCurrentUserChanged`
   *  subscriber checks this so it doesn't double-notify — setCurrentUser
   *  owns the fan-out decision (id-token always, auth-state on uid
   *  change). The subscriber only notifies for EXTERNAL mutations
   *  (direct sandbox writes, `reset()`, another handle). */
  private applyingTransition = false;

  /** Per-uid current ID token + result. Refreshed on each
   *  `getIdToken(forceRefresh=true)` and on each new sign-in
   *  transition (so a sign-out / sign-in round-trip mints a fresh
   *  token, matching prod's "new session = new token" semantics).
   *  Subsequent `getIdToken(false)` reads return the cached value. */
  private readonly tokenCache = new Map<string, { token: string; result: IdTokenResult }>();

  /** Monotonic counter used to disambiguate freshly-minted tokens
   *  for the same uid + claims map. Without this, two refreshes that
   *  happen within the same millisecond would hash to the same
   *  string (claims map + iat tie-breaker not enough). */
  private nextTokenSerial = 1;

  /**
   * Current persistence mode — mirrors the real Firebase SDK's
   * `setPersistence` semantics. Default is `'LOCAL'` (Firebase default:
   * `browserLocalPersistence` keeps you signed in across reloads and
   * browser restarts).
   *
   * Stored here on the backend so the persistence controller can read it
   * without knowing about auth internals. The `auth/index.ts` top-level
   * `setPersistence` function writes this via `setPersistenceMode`; the
   * controller reads it via `getPersistenceMode` on every session save.
   *
   * Subscribers to persistence-mode changes (the set holding the
   * controller's session-save callback) are notified by `setPersistenceMode`
   * so a `setPersistence` call that changes the mode immediately migrates
   * the session to the new store without waiting for the next sign-in.
   */
  private persistenceMode: 'LOCAL' | 'SESSION' | 'NONE' = 'LOCAL';

  /** Per-uid provider of the *current/most-recent* sign-in session —
   *  backs `IdTokenResult.signInProvider` and the synthesized
   *  `firebase.sign_in_provider` token claim. Written by each
   *  sign-in path via {@link setCurrentUser}'s `signInProvider`
   *  argument; `null` for identities driven directly through the
   *  test driver (`sandbox.setUser`), which has no prod analog. */
  private readonly signInProviderByUid = new Map<string, string | null>();

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    // Initialize cachedUser from whatever the sandbox currently has —
    // a fresh sandbox starts at null, but if another Auth handle
    // (or a manual mutation) already set a user, mirror it.
    this.cachedUser = this.buildUserFromState(sandbox.currentUser);
    // Subscribe to sandbox-level changes — covers cases where a
    // future bridge (or another `getAuth` handle) mutates
    // currentUser directly. Fans out to both listener registries.
    //
    // Critically, this must NOT clobber a richer `User` that
    // `setCurrentUser` already cached for the SAME identity. Sign-in
    // strategies (popup / redirect / credential / `setUser`) hand us a
    // full `User` (email, displayName, anonymous flag) and stash it on
    // `cachedUser` *before* writing `sandbox.currentUser`; that write
    // fires this subscriber synchronously. Rebuilding from the bare
    // `AuthState` here would drop every field `AuthState` can't carry
    // (it only holds uid + claims) and mint a fresh object, breaking
    // `cred.user === auth.currentUser`. So we only rebuild when the
    // change came from *outside* this backend — i.e. the cached user's
    // uid no longer matches the new state (a direct sandbox mutation,
    // `reset()`, or another handle's sign-in). Matches upstream, where
    // `_updateCurrentUser(userCredential.user)` makes the credential's
    // user the live `currentUser` — same fields, same reference
    // (`core/strategies/anonymous.ts:60-68`, `auth_impl.ts:714-719`).
    sandbox.onCurrentUserChanged((state) => {
      // `setCurrentUser` owns the fan-out for transitions it drives (it
      // calls `notifyAuthListeners` itself with the right id-token /
      // auth-state split). Skip here so we don't double-notify.
      if (this.applyingTransition) return;
      const stateUid = state === null ? null : state.uid;
      const cachedUid = this.cachedUser?.uid ?? null;
      if (stateUid !== cachedUid) {
        this.cachedUser = this.buildUserFromState(state);
      }
      // External mutation (direct sandbox write / `reset()` / another
      // handle): notify with the same id-token-always / auth-state-on-
      // uid-change rule.
      this.notifyAuthListeners();
    });
  }

  /** Snapshot of the current user — backs `auth.currentUser`. */
  getCurrentUser(): User | null {
    return this.cachedUser;
  }

  // ─── Listener registries ────────────────────────────────────────────

  /**
   * Subscribe to user change. Fires *immediately* on subscribe with
   * the current value (mirrors `firebase/auth`'s
   * `onAuthStateChanged` semantics).
   *
   * `kind: 'auth-state'` and `kind: 'id-token'` share the identity-
   * transition fan-out path; additionally, `getIdToken(true)` fans
   * out to the `'id-token'` registry only (without re-firing
   * `'auth-state'`). Matches prod: `onIdTokenChanged` sees both
   * identity changes AND forced token refreshes.
   */
  subscribe(kind: 'auth-state' | 'id-token', observer: AuthObserver): Unsubscribe {
    const list = kind === 'auth-state' ? this.authStateSubs : this.idTokenSubs;
    // One record per subscribe() — duplicate fns register independently
    // (AUTH-B4). Each carries its own initial-fire bookkeeping, so a
    // resubscribe or a second registration of the same fn is NOT
    // suppressed by a sibling's delivery (AUTH-B3).
    const reg: Registration = { observer, hasFired: false, lastValue: null };
    list.push(reg);
    // Fire immediately with the current value — upstream semantics
    // (`auth_impl.ts:728-742`: each registration schedules its own
    // `promise.then(() => cb(currentUser))`). Use a microtask so a
    // synchronous unsubscribe from inside the observer doesn't race with
    // fanOut's iteration, AND so a setCurrentUser that fires
    // synchronously between subscribe and this microtask can deliver
    // first; we then skip the replay only when THIS registration already
    // saw the current value (avoids the same-value double-fire in the
    // mount-time `onAuthStateChanged(auth, fn); signInAnonymously(auth)`
    // pattern — a sandbox-only race prod can't exhibit, COMPAT row 31).
    queueMicrotask(() => {
      if (!list.includes(reg)) return;
      if (reg.hasFired && reg.lastValue === this.cachedUser) return;
      this.deliverOne(reg, this.cachedUser);
    });
    return () => {
      const i = list.indexOf(reg);
      if (i !== -1) list.splice(i, 1);
    };
  }

  /**
   * Notify the requested registries of the current user. Snapshots
   * the registration list before iteration so unsubscribes during
   * emission don't skip remaining subscribers (upstream semantics).
   *
   * `kind: 'both'` (default) fires both auth-state and id-token
   * registries — used for identity transitions.
   * `kind: 'id-token'` fires ONLY the id-token registry — used for
   * forced token refreshes, where the user identity hasn't changed
   * but the token has. Matches prod: `onIdTokenChanged` sees refresh
   * events; `onAuthStateChanged` does not.
   */
  private fanOut(kind: 'both' | 'id-token' | 'auth-state' = 'both'): void {
    const user = this.cachedUser;
    if (kind === 'both' || kind === 'auth-state') {
      for (const reg of [...this.authStateSubs]) this.deliverOne(reg, user);
    }
    if (kind === 'both' || kind === 'id-token') {
      for (const reg of [...this.idTokenSubs]) this.deliverOne(reg, user);
    }
  }

  /**
   * Mirror of upstream `notifyAuthListeners` (`auth_impl.ts:714-723`):
   *   - `onIdTokenChanged` fires on EVERY notify (every identity update,
   *     including a same-uid re-sign-in that mints a fresh token —
   *     AUTH-B8);
   *   - `onAuthStateChanged` fires ONLY when the uid changed vs the last
   *     notification (`lastNotifiedUid`) — a same-uid profile-shape
   *     change does NOT re-fire auth-state (AUTH-B7).
   * Call this after `cachedUser` is updated.
   */
  private notifyAuthListeners(): void {
    this.fanOut('id-token');
    const currentUid = this.cachedUser?.uid ?? null;
    if (this.lastNotifiedUid !== currentUid) {
      this.lastNotifiedUid = currentUid;
      this.fanOut('auth-state');
    }
  }

  private deliverOne(reg: Registration, user: User | null): void {
    reg.hasFired = true;
    reg.lastValue = user;
    const observer = reg.observer;
    try {
      if (typeof observer === 'function') {
        observer(user);
      } else if (observer.next) {
        observer.next(user);
      }
    } catch {
      // Observational — swallow so a faulty subscriber can't
      // destabilize the auth state machine.
    }
  }

  // ─── User DB ────────────────────────────────────────────────────────

  /** Build a fresh {@link StoredUser} with admin-field defaults. */
  private makeStored(
    init: Partial<StoredUser> & { uid: string },
  ): StoredUser {
    return {
      email: null,
      password: null,
      displayName: null,
      phoneNumber: null,
      photoUrl: null,
      customClaims: {},
      isAnonymous: false,
      providerUserInfo: [],
      disabled: false,
      emailVerified: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      ...init,
    };
  }

  /** Fan a coarse "user DB changed" notification out to
   *  `subscribeUsers` listeners. Snapshotted iteration; throwing
   *  listeners are isolated (same policy as the auth observers). */
  private notifyUsersChanged(): void {
    for (const cb of [...this.userDbSubs]) {
      try {
        cb();
      } catch {
        // Observational — swallow.
      }
    }
  }

  /**
   * Emit an auth {@link ServiceMutationEvent} onto the sandbox's unified
   * `onEvent`/`history()` stream (Pyric Studio keystone). Best-effort and
   * fully isolated — a throw from the emit path (or a sandbox that somehow
   * isn't a real `SandboxImpl`) must NOT break the auth operation that
   * triggered it, so we swallow. `auth` defaults to the current sandbox
   * identity; admin ops (createUser/updateUser/deleteUser) pass `null`
   * since they have no acting session. `actor` defaults to `{ kind: 'app' }`
   * via `stampProvenance`.
   */
  private emitAuthEvent(
    op: string,
    fields: { path?: string; auth?: AuthState; before?: unknown; after?: unknown; detail?: Record<string, unknown> } = {},
  ): void {
    try {
      emitSandboxEvent(
        this.sandbox,
        makeServiceMutationEvent({
          service: 'auth',
          op,
          path: fields.path,
          auth: fields.auth ?? this.sandbox.currentUser,
          before: fields.before,
          after: fields.after,
          detail: fields.detail,
        }),
        { service: 'auth' },
      );
    } catch {
      // Observational — never let event emission destabilize auth.
    }
  }

  /** Subscribe to user-DB mutations (seed/create/update/delete/clear,
   *  provider links, lastLoginAt bumps). Coarse: no payload, no
   *  initial fire — re-list via `listUsers` on each callback. */
  subscribeUsers(cb: () => void): Unsubscribe {
    this.userDbSubs.add(cb);
    return () => { this.userDbSubs.delete(cb); };
  }

  // ─── Persistence mode ───────────────────────────────────────────────

  /**
   * Read the current persistence mode. Used by the session-persistence
   * controller to decide which web-storage slot (local / session) to
   * write the signed-in uid into.
   *
   * The default value is `'LOCAL'` — matches Firebase's default of
   * `browserLocalPersistence` (you stay signed in across page reloads
   * and browser restarts unless you explicitly call `setPersistence`).
   */
  getPersistenceMode(): 'LOCAL' | 'SESSION' | 'NONE' {
    return this.persistenceMode;
  }

  /**
   * Record the new persistence mode. Called by the auth `setPersistence`
   * function when the sandbox target receives a mode change.
   *
   * Changing the mode notifies the session-change subscribers so the
   * persistence controller can IMMEDIATELY migrate the stored uid to
   * the new web-storage slot — matching the real SDK's behavior where
   * `setPersistence` carries the active session across modes before
   * returning.
   *
   * Why notify on mode change (not just on sign-in/out): the session
   * controller subscribes to "something about this session changed"
   * events and re-reads both `currentUid()` and `mode()` on each fire.
   * Notifying here lets the controller react to a mode change with the
   * same code path as a sign-in/out, rather than a separate migration
   * hook.
   */
  setPersistenceMode(mode: 'LOCAL' | 'SESSION' | 'NONE'): void {
    if (this.persistenceMode === mode) return; // no-op — nothing to migrate
    this.persistenceMode = mode;
    // Notify session-change subscribers so the controller migrates the
    // stored uid to the new store immediately. The controller reads
    // mode() on the fire, so it will see the already-updated value.
    this.notifySessionChanged();
  }

  /**
   * Subscribers that need to react to ANY session state change —
   * sign-in, sign-out, or persistence-mode change. The controller
   * installs one subscriber here to drive session saves.
   *
   * Separate from `currentUserSubs` (on the sandbox) because we need
   * to fire on mode changes (which don't change the currentUser) and
   * because the backend owns the mode — it's cleaner to keep both
   * signals on the same object.
   */
  private readonly sessionChangeSubs = new Set<() => void>();

  /** Notify all session-change subscribers. Used by `setCurrentUser`
   *  (sign-in / sign-out) and by `setPersistenceMode` (mode change). */
  private notifySessionChanged(): void {
    for (const cb of [...this.sessionChangeSubs]) {
      try {
        cb();
      } catch {
        // Observational — swallow.
      }
    }
  }

  /**
   * Subscribe to session-level changes: sign-in, sign-out, and
   * persistence-mode changes. The persistence controller installs one
   * subscription here and re-saves the session on every fire.
   *
   * This is the mechanism the `PersistableService.session.subscribe`
   * hook exposes — the controller doesn't need to know it's subscribing
   * to two separate event sources (sign-in/out AND mode); they both
   * flow through this one subscription.
   */
  subscribeSession(cb: () => void): Unsubscribe {
    this.sessionChangeSubs.add(cb);
    return () => { this.sessionChangeSubs.delete(cb); };
  }

  seedUsers(users: ReadonlyArray<SeedUser>): void {
    for (const u of users) {
      // Re-seeding an existing uid OVERWRITES it (documented idempotency,
      // `index.ts` seedUsers docstring). If the new email differs, drop
      // the stale email→record mapping so the old email no longer signs
      // in (AUTH-B9) — otherwise both emails would resolve, the old one
      // to a now-orphaned record.
      const prior = this.usersByUid.get(u.uid);
      if (prior?.email && prior.email.toLowerCase() !== u.email.toLowerCase()) {
        this.usersByEmail.delete(prior.email.toLowerCase());
      }
      const record = this.makeStored({
        uid: u.uid,
        email: u.email,
        password: u.password,
        displayName: u.displayName ?? null,
        customClaims: u.customClaims ?? {},
        providerUserInfo: [{ providerId: u.providerId ?? 'password' }],
      });
      this.usersByEmail.set(u.email.toLowerCase(), record);
      this.usersByUid.set(u.uid, record);
    }
    if (users.length > 0) this.notifyUsersChanged();
  }

  /**
   * Export the user DB as `SeedUser`s — the exact shape `seedUsers`
   * accepts, so export → seed round-trips (the persistence substrate,
   * the design rationale §3c). Identities with an email but no
   * password (provider-flow users created via `createSignInCredential`)
   * export with {@link NO_PASSWORD_SENTINEL} so they survive the
   * round-trip (same trick hosts already use when seeding popup
   * identities). Anonymous users (no email) are NOT exported — they are
   * ephemeral by design; documented divergence from prod's persisted
   * anonymous sessions.
   */
  exportUsers(): SeedUser[] {
    const out: SeedUser[] = [];
    for (const u of this.usersByUid.values()) {
      if (u.email === null) continue; // anonymous — not round-trippable
      const seed: SeedUser = {
        uid: u.uid,
        email: u.email,
        password: u.password ?? NO_PASSWORD_SENTINEL,
        providerId: u.providerUserInfo[0]?.providerId ?? 'password',
      };
      if (u.displayName !== null) seed.displayName = u.displayName;
      if (Object.keys(u.customClaims).length > 0) seed.customClaims = u.customClaims;
      out.push(seed);
    }
    return out;
  }

  /**
   * Re-establish a signed-in session for an EXISTING identity — the
   * substrate behind web-storage session persistence (`setPersistence`
   * parity at the serve layer). Fires the auth-state listeners exactly
   * like a real restored session. Throws `auth/user-not-found` for
   * unknown uids and `auth/user-disabled` for disabled accounts (a
   * restore is a sign-in).
   */
  restoreSession(uid: string): User {
    const stored = this.usersByUid.get(uid);
    if (!stored) {
      throw makeAuthError('auth/user-not-found', `restoreSession: no identity with uid ${uid}.`);
    }
    if (stored.disabled) {
      throw makeAuthError('auth/user-disabled', `restoreSession: user ${uid} is disabled.`);
    }
    const providerId = stored.isAnonymous
      ? 'anonymous'
      : (stored.providerUserInfo[0]?.providerId ?? 'password');
    const user = this.buildUserFromStored(stored);
    this.setCurrentUser(user, providerId);
    return user;
  }

  findByEmail(email: string): StoredUser | undefined {
    return this.usersByEmail.get(email.toLowerCase());
  }

  createEmailPasswordUser(email: string, password: string): StoredUser {
    // Validate format BEFORE checking duplicates so an attacker can't
    // enumerate seeded emails by varying the malformed-vs-valid shape.
    // Matches prod's order — the format error fires before any lookup
    // against the user DB.
    validateEmailFormat(email);
    validatePasswordStrength(password);
    const key = email.toLowerCase();
    if (this.usersByEmail.has(key)) {
      throw makeAuthError(
        'auth/email-already-in-use',
        `An account already exists for ${email}.`,
      );
    }
    const uid = `email-${key}-${this.usersByEmail.size + 1}`;
    const record = this.makeStored({
      uid,
      email,
      password,
      providerUserInfo: [{ providerId: 'password' }],
    });
    this.usersByEmail.set(key, record);
    this.usersByUid.set(uid, record);
    this.notifyUsersChanged();
    // App-driven create (createUserWithEmailAndPassword) — the acting
    // identity is whoever is currently signed in (usually null/anonymous).
    this.emitAuthEvent('user_create', { path: uid, after: this.toRecord(record) });
    return record;
  }

  // ─── Identity mutation ──────────────────────────────────────────────

  /**
   * Set the active user. Owns the fan-out decision directly (rather than
   * leaning on the sandbox setter's structural-equality dedup), so it can
   * mirror upstream `notifyAuthListeners`: `onIdTokenChanged` fires on
   * every sign-in (incl. a same-uid re-sign-in that mints a fresh token —
   * AUTH-B8), while `onAuthStateChanged` fires only on a uid change
   * (AUTH-B7). The `applyingTransition` guard suppresses the synchronous
   * `onCurrentUserChanged` subscriber so we don't double-notify.
   *
   * `signInProvider` (when passed) records the provider of THIS
   * sign-in session — it feeds `IdTokenResult.signInProvider` and the
   * synthesized `firebase.sign_in_provider` claim. Omitted by the
   * test driver (`sandbox.setUser`), which leaves any previous value
   * in place.
   */
  setCurrentUser(user: User | null, signInProvider?: string | null): void {
    if (user === null) {
      // Sign-out. Drop the cached token so a later re-sign-in for the
      // same uid mints a fresh one ("new session = new token"). Fire
      // listeners only if we were actually signed in (signing out an
      // already-null session is a no-op, matching prod).
      const previousUser = this.cachedUser;
      this.cachedUser = null;
      this.applyingTransition = true;
      try {
        this.sandbox.currentUser = null;
      } finally {
        this.applyingTransition = false;
      }
      if (previousUser) {
        this.tokenCache.delete(previousUser.uid);
        this.notifyAuthListeners();
        this.notifySessionChanged();
        // Sign-out: the acting identity WAS the user that just left; no
        // `after` state (signed out). Only emit on a real transition
        // (signing out an already-null session is a prod no-op above).
        this.emitAuthEvent('sign_out', {
          path: previousUser.uid,
          auth: { uid: previousUser.uid },
        });
      }
      return;
    }

    // Record this session's provider BEFORE any token mint below so
    // the freshly-minted token carries the right sign_in_provider.
    if (signInProvider !== undefined) {
      this.signInProviderByUid.set(user.uid, signInProvider);
    }

    // Look up custom claims for this uid (if we know them). Falls
    // back to the empty claims map for anonymous / freshly-minted
    // users.
    const stored = this.usersByUid.get(user.uid);
    const claims = stored?.customClaims ?? {};

    // A `signInProvider` argument marks an actual sign-in (the test
    // driver omits it) — bump the record's lastLoginAt.
    if (signInProvider !== undefined && stored) {
      stored.lastLoginAt = new Date().toISOString();
      this.notifyUsersChanged();
    }

    // Stash the (possibly richer) User snapshot so listeners fire with
    // the full display name / email, not just the AuthState round-trip.
    this.cachedUser = user;
    // Every sign-in mints a fresh token — a new session, even if the uid
    // is unchanged (AUTH-B8: a same-uid re-sign-in still rotates the
    // token, which `onIdTokenChanged` then observes). Matches prod's
    // "new session = new token".
    this.tokenCache.set(user.uid, this.mintToken(user.uid, claims));

    // Push to the sandbox under the guard so the synchronous subscriber
    // doesn't notify — we drive the fan-out below with the correct
    // id-token / auth-state split.
    const nextState: AuthState = { uid: user.uid, token: claims };
    this.applyingTransition = true;
    try {
      this.sandbox.currentUser = nextState;
    } finally {
      this.applyingTransition = false;
    }
    this.notifyAuthListeners();
    // Notify session-change subscribers so the persistence controller
    // can save the new signed-in uid to the appropriate web-storage
    // slot. This fires AFTER notifyAuthListeners so the auth state is
    // fully settled before the controller reads currentUid() + mode().
    this.notifySessionChanged();
    // Sign-in state change. `signInProvider !== undefined` marks a REAL
    // sign-in (anonymous / email-password / popup / redirect / restore) —
    // the test driver (`sandbox.setUser`) omits it and is not a sign-in
    // worth surfacing on the activity stream. The acting identity IS the
    // user that just signed in.
    if (signInProvider !== undefined) {
      this.emitAuthEvent('sign_in', {
        path: user.uid,
        auth: nextState,
        after: { uid: user.uid, isAnonymous: user.isAnonymous, email: user.email },
        detail: { providerId: signInProvider ?? 'anonymous' },
      });
    }
  }

  // ─── Mock-result registry ───────────────────────────────────────────

  setMockResult(providerId: string, result: UserCredential): void {
    this.mockResults.set(providerId, result);
  }

  consumeMockResult(providerId: string): UserCredential | undefined {
    // One-shot per stage — clear after read so the next call
    // requires a fresh `mockSignInResult`. Matches `firebase/auth`'s
    // "one popup per call" semantics.
    const result = this.mockResults.get(providerId);
    if (result) this.mockResults.delete(providerId);
    return result;
  }

  // ─── Popup/redirect resolver + redirect-result slot ─────────────────

  setResolver(resolver: AuthFlowResolver | null): void {
    this.resolver = resolver;
  }

  getResolver(): AuthFlowResolver | null {
    return this.resolver;
  }

  /** Stash the credential a `signInWithRedirect` produced; `getRedirectResult`
   *  returns-and-clears it. */
  setRedirectResult(result: UserCredential): void {
    this.redirectResult = result;
  }

  takeRedirectResult(): UserCredential | null {
    const r = this.redirectResult;
    this.redirectResult = null;
    return r;
  }

  /**
   * Record a provider-flow sign-in (popup / redirect / credential)
   * against the user DB so the identity shows up in `listIdentities`
   * with its real provider. Upserts: unknown uids get a fresh record
   * (no password — these identities can't sign in via
   * `signInWithEmailAndPassword`); known uids get the provider
   * appended to `providerUserInfo` if it isn't already linked.
   */
  recordProviderSignIn(user: User, providerId: string): void {
    let changed = false;
    let stored = this.usersByUid.get(user.uid);
    if (!stored) {
      stored = this.makeStored({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        isAnonymous: user.isAnonymous,
      });
      this.usersByUid.set(user.uid, stored);
      if (user.email) this.usersByEmail.set(user.email.toLowerCase(), stored);
      changed = true;
    }
    if (!stored.providerUserInfo.some((p) => p.providerId === providerId)) {
      stored.providerUserInfo.push({ providerId });
      changed = true;
    }
    if (changed) this.notifyUsersChanged();
  }

  /**
   * Mint a sign-in credential for a host-driven flow (the account
   * picker behind `AuthFlowResolver`). Token + claims synthesis is
   * backend-owned: the returned `User`'s `getIdToken` /
   * `getIdTokenResult` route through this backend's token cache, so
   * helper-driven sign-ins get real (cached, refreshable,
   * provider-labeled) sandbox tokens instead of host-synthesized
   * strings.
   *
   * Two request shapes:
   *   - `{providerId, uid}` — credential for an EXISTING identity
   *     (the picker's "pick" action). Throws `invalid-argument` for
   *     unknown uids.
   *   - `{providerId, spec}` — upsert a new identity (the picker's
   *     "add account"). If `spec.email` already belongs to a stored
   *     user, that identity is reused and the provider linked
   *     (Google-style same-email account reuse); otherwise a fresh
   *     record is created with uid `spec.uid ?? '<providerId>:<email>'`
   *     and NO password (provider identities can't sign in via
   *     `signInWithEmailAndPassword`).
   *
   * In both shapes the provider is linked into `providerUserInfo`.
   * The credential does NOT sign the user in — hand it to the
   * resolver's promise; `signInWithPopup`/`signInWithRedirect`
   * complete the sign-in.
   */
  createSignInCredential(
    req:
      | { providerId: string; uid: string }
      | { providerId: string; spec: SignInIdentitySpec },
  ): UserCredential {
    const { providerId } = req;
    let stored: StoredUser;
    if ('uid' in req) {
      const found = this.usersByUid.get(req.uid);
      if (!found) {
        throw makeAuthError(
          'auth/user-not-found',
          `createSignInCredential: no identity with uid ${req.uid}. Use the {spec} shape to create one.`,
        );
      }
      stored = found;
    } else {
      const { spec } = req;
      const byEmail = this.usersByEmail.get(spec.email.toLowerCase());
      if (byEmail) {
        stored = byEmail;
      } else {
        stored = this.makeStored({
          uid: spec.uid ?? `${providerId}:${spec.email}`,
          email: spec.email,
          displayName: spec.displayName ?? null,
          customClaims: spec.customClaims ?? {},
        });
        this.usersByUid.set(stored.uid, stored);
        this.usersByEmail.set(spec.email.toLowerCase(), stored);
        this.notifyUsersChanged();
      }
    }
    if (!stored.providerUserInfo.some((p) => p.providerId === providerId)) {
      stored.providerUserInfo.push({ providerId });
      this.notifyUsersChanged();
    }
    return {
      user: this.buildUserFromStored(stored),
      providerId,
      operationType: 'signIn',
    };
  }

  /** Snapshot of every known identity (seeded + created), for a host
   *  account-picker UI. No `firebase/auth` equivalent — sandbox-only.
   *
   *  `providerId` is the primary provider label (first linked
   *  provider, or `'anonymous'` for anonymous users);
   *  `providerUserInfo` is the full emulator-shaped array. */
  listIdentities(): Array<{
    uid: string;
    email: string | null;
    displayName: string | null;
    providerId: string;
    providerUserInfo: ProviderUserInfo[];
    isAnonymous: boolean;
    customClaims: Record<string, unknown>;
  }> {
    return [...this.usersByUid.values()].map((u) => ({
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      providerId: u.isAnonymous
        ? 'anonymous'
        : u.providerUserInfo[0]?.providerId ?? 'password',
      providerUserInfo: [...u.providerUserInfo],
      isAnonymous: u.isAnonymous,
      customClaims: u.customClaims,
    }));
  }

  // ─── User-admin surface (emulator-REST-shaped) ──────────────────────

  /** Public snapshot of a stored user. Defensive copies — mutating a
   *  returned record never touches the DB. */
  private toRecord(u: StoredUser): AuthUserRecord {
    return {
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      phoneNumber: u.phoneNumber,
      photoUrl: u.photoUrl,
      customClaims: { ...u.customClaims },
      providerUserInfo: u.providerUserInfo.map((p) => ({ ...p })),
      isAnonymous: u.isAnonymous,
      disabled: u.disabled,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  /** Every user in the DB (seeded, created, signed-in-via-provider,
   *  anonymous), as admin records. */
  listUsers(): AuthUserRecord[] {
    return [...this.usersByUid.values()].map((u) => this.toRecord(u));
  }

  /** Admin user creation. Does NOT sign the user in (unlike
   *  `createUserWithEmailAndPassword`) — matches the emulator's
   *  add-user flow / admin SDK semantics. */
  createUser(req: CreateUserRequest): AuthUserRecord {
    const uid = req.uid ?? `user-${this.nextAdminUserId++}`;
    if (this.usersByUid.has(uid)) {
      throw makeAuthError(
        'auth/uid-already-exists',
        `createUser: a user with uid ${uid} already exists.`,
      );
    }
    if (req.email !== undefined) {
      validateEmailFormat(req.email);
      if (this.usersByEmail.has(req.email.toLowerCase())) {
        throw makeAuthError(
          'auth/email-already-in-use',
          `An account already exists for ${req.email}.`,
        );
      }
    }
    if (req.password !== undefined) {
      validatePasswordStrength(req.password);
      if (req.email === undefined) {
        throw makeAuthError(
          'auth/invalid-email',
          'createUser: a password requires an email.',
        );
      }
    }
    const record = this.makeStored({
      uid,
      email: req.email ?? null,
      password: req.password ?? null,
      displayName: req.displayName ?? null,
      phoneNumber: req.phoneNumber ?? null,
      photoUrl: req.photoUrl ?? null,
      customClaims: req.customClaims ?? {},
      disabled: req.disabled ?? false,
      emailVerified: req.emailVerified ?? false,
      providerUserInfo:
        req.password !== undefined ? [{ providerId: 'password' }] : [],
    });
    this.usersByUid.set(uid, record);
    if (record.email) this.usersByEmail.set(record.email.toLowerCase(), record);
    this.notifyUsersChanged();
    const created = this.toRecord(record);
    this.emitAuthEvent('user_create', { path: uid, auth: null, after: created });
    return created;
  }

  /** Admin user update. `undefined` fields untouched; `customClaims`
   *  replaces the whole map (admin `setCustomUserClaims` semantics).
   *  Claims changes reach an ACTIVE session only on the next token
   *  refresh / sign-in — same propagation story as prod. */
  updateUser(uid: string, update: UpdateUserRequest): AuthUserRecord {
    const stored = this.usersByUid.get(uid);
    if (!stored) {
      throw makeAuthError('auth/user-not-found', `No user found for uid ${uid}.`);
    }
    const before = this.toRecord(stored);
    if (update.email !== undefined) {
      validateEmailFormat(update.email);
      const key = update.email.toLowerCase();
      const existing = this.usersByEmail.get(key);
      if (existing && existing !== stored) {
        throw makeAuthError(
          'auth/email-already-in-use',
          `An account already exists for ${update.email}.`,
        );
      }
      if (stored.email) this.usersByEmail.delete(stored.email.toLowerCase());
      stored.email = update.email;
      this.usersByEmail.set(key, stored);
    }
    if (update.password !== undefined) {
      validatePasswordStrength(update.password);
      stored.password = update.password;
      // Setting a password links the password provider — matches the
      // Identity Toolkit (an account gains providerUserInfo entry
      // when a password is set on it).
      if (!stored.providerUserInfo.some((p) => p.providerId === 'password')) {
        stored.providerUserInfo.push({ providerId: 'password' });
      }
    }
    if (update.displayName !== undefined) stored.displayName = update.displayName;
    if (update.customClaims !== undefined) {
      stored.customClaims = { ...update.customClaims };
    }
    if (update.disabled !== undefined) stored.disabled = update.disabled;
    if (update.emailVerified !== undefined) stored.emailVerified = update.emailVerified;
    this.notifyUsersChanged();
    const after = this.toRecord(stored);
    this.emitAuthEvent('user_update', { path: uid, auth: null, before, after });
    return after;
  }

  /** Admin user deletion. The active session (if it's this user) is
   *  NOT terminated — matches prod, where admin deletion doesn't kill
   *  live client sessions until the token is revoked/refreshed. */
  deleteUser(uid: string): void {
    const stored = this.usersByUid.get(uid);
    if (!stored) {
      throw makeAuthError('auth/user-not-found', `No user found for uid ${uid}.`);
    }
    const before = this.toRecord(stored);
    this.usersByUid.delete(uid);
    if (stored.email && this.usersByEmail.get(stored.email.toLowerCase()) === stored) {
      this.usersByEmail.delete(stored.email.toLowerCase());
    }
    this.tokenCache.delete(uid);
    this.signInProviderByUid.delete(uid);
    this.notifyUsersChanged();
    this.emitAuthEvent('user_delete', { path: uid, auth: null, before });
  }

  /** Drop every user record (the emulator's "delete all accounts").
   *  Active sessions are untouched, like {@link deleteUser}. */
  clearUsers(): void {
    if (this.usersByUid.size === 0 && this.usersByEmail.size === 0) return;
    const count = this.usersByUid.size;
    this.usersByUid.clear();
    this.usersByEmail.clear();
    this.notifyUsersChanged();
    this.emitAuthEvent('users_clear', { path: '*', auth: null, detail: { count } });
  }

  /** Throw `auth/user-disabled` if the uid resolves to a disabled
   *  record. Called by every provider-flow sign-in path; the
   *  email/password path runs the same check inside
   *  {@link validatePassword}. */
  assertSignInAllowed(uid: string): void {
    if (this.usersByUid.get(uid)?.disabled) {
      throw makeAuthError(
        'auth/user-disabled',
        'The user account has been disabled by an administrator.',
      );
    }
  }

  // ─── User factories ─────────────────────────────────────────────────

  /**
   * Mint a `User` shell for the given stored record. Used by all
   * email/password and popup sign-in paths.
   */
  buildUserFromStored(stored: StoredUser): User {
    return this.makeUser({
      uid: stored.uid,
      email: stored.email,
      displayName: stored.displayName,
      isAnonymous: stored.isAnonymous,
      claims: stored.customClaims,
      // Carry the profile fields through so a rebuilt/restored user (session
      // restore, snapshot round-trip) keeps its photoURL / emailVerified /
      // phoneNumber. Additive: these were null/undefined before this landed.
      photoURL: stored.photoUrl,
      emailVerified: stored.emailVerified,
      phoneNumber: stored.phoneNumber,
    });
  }

  /** Mint a fresh anonymous user with an auto-generated uid. Records
   *  the identity in the user DB (empty `providerUserInfo`, matching
   *  the emulator) so `listIdentities` / future user-admin surfaces
   *  see anonymous accounts too. */
  mintAnonymousUser(): User {
    const uid = `anonymous-${this.nextAnonymousId++}`;
    const record = this.makeStored({ uid, isAnonymous: true });
    this.usersByUid.set(uid, record);
    this.notifyUsersChanged();
    this.emitAuthEvent('user_create', { path: uid, after: this.toRecord(record), detail: { isAnonymous: true } });
    return this.makeUser({
      uid,
      email: null,
      displayName: null,
      isAnonymous: true,
      claims: {},
    });
  }

  // ─── Detached sessions (per-connection identity substrate) ──────────

  /**
   * Mint a session identity WITHOUT making it the global current user —
   * the substrate for per-connection identity at the serve layer (one
   * SharedWorker sandbox, N tab sessions; issue #754). Performs a real
   * sign-in's bookkeeping — provider record, `lastLoginAt` bump, a fresh
   * token (new session = new token), the `sign_in` activity event — but
   * leaves `sandbox.currentUser`, the auth-state listeners, and the
   * session-change subscribers untouched.
   *
   * Returns the `User` plus the {@link AuthState} a data context should
   * carry (`sandbox.withAuth(state)`) so rules evaluate exactly as they
   * would for a globally signed-in user (`request.auth.uid` + custom
   * claims on `request.auth.token`).
   */
  mintDetachedSession(request: MintSessionRequest): MintedSession {
    switch (request.kind) {
      case 'anonymous':
        return this.establishDetachedSession(this.mintAnonymousUser(), 'anonymous');
      case 'password':
        return this.establishDetachedSession(
          this.buildUserFromStored(this.validatePassword(request.email, request.password)),
          'password',
        );
      case 'createPassword':
        return this.establishDetachedSession(
          this.buildUserFromStored(this.createEmailPasswordUser(request.email, request.password)),
          'password',
        );
      case 'uid': {
        // restoreSession semantics minus the global set: an EXISTING
        // identity (per-tab session restore / provider-bridge accept).
        const stored = this.usersByUid.get(request.uid);
        if (!stored) {
          throw makeAuthError('auth/user-not-found', `mintSession: no identity with uid ${request.uid}.`);
        }
        if (stored.disabled) {
          throw makeAuthError('auth/user-disabled', `mintSession: user ${request.uid} is disabled.`);
        }
        const providerId = stored.isAnonymous
          ? 'anonymous'
          : (stored.providerUserInfo[0]?.providerId ?? 'password');
        return this.establishDetachedSession(this.buildUserFromStored(stored), providerId);
      }
    }
  }

  /** The shared sign-in bookkeeping behind {@link mintDetachedSession} —
   *  everything {@link setCurrentUser} does for a real sign-in EXCEPT the
   *  global-session parts. */
  private establishDetachedSession(user: User, signInProvider: string): MintedSession {
    this.signInProviderByUid.set(user.uid, signInProvider);
    const stored = this.usersByUid.get(user.uid);
    const claims = stored?.customClaims ?? {};
    if (stored) {
      stored.lastLoginAt = new Date().toISOString();
      this.notifyUsersChanged();
    }
    this.tokenCache.set(user.uid, this.mintToken(user.uid, claims));
    const state = { uid: user.uid, token: claims };
    this.emitAuthEvent('sign_in', {
      path: user.uid,
      auth: state,
      after: { uid: user.uid, isAnonymous: user.isAnonymous, email: user.email },
      // `session: 'connection'` marks a per-connection (detached) session so
      // observability can tell it from a global sign-in.
      detail: { providerId: signInProvider, session: 'connection' },
    });
    return { user, state };
  }

  /** Reconstruct a `User` object from an {@link AuthState}. Returns
   *  `null` for `null` input. Used to mirror sandbox-level state
   *  changes that didn't originate from this backend. */
  private buildUserFromState(state: AuthState): User | null {
    if (state === null) return null;
    // Look up DB-stored attrs (email, displayName) by uid; fall back
    // to anonymous shape if unknown.
    const stored = this.usersByUid.get(state.uid);
    if (stored) {
      return this.buildUserFromStored({
        ...stored,
        customClaims: state.token ?? stored.customClaims,
      });
    }
    return this.makeUser({
      uid: state.uid,
      email: null,
      displayName: null,
      isAnonymous: state.uid.startsWith('anonymous-'),
      claims: state.token ?? {},
    });
  }

  // ─── Token cache / refresh ──────────────────────────────────────────

  /**
   * Mint a fresh `{ token, result }` for the given uid + claims. Used
   * both on initial `getIdToken` (cache miss) and on a forced
   * refresh. Each call advances {@link nextTokenSerial} so two
   * refreshes inside the same millisecond still produce distinct
   * token strings.
   */
  private mintToken(
    uid: string,
    claims: Record<string, unknown>,
  ): { token: string; result: IdTokenResult } {
    const issuedAt = new Date();
    // 100 years out — sandbox tokens never expire.
    const expires = new Date(issuedAt.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    const serial = this.nextTokenSerial++;
    const token = sandboxTokenFor(uid, claims, serial);
    // The provider of the current sign-in session for this uid —
    // recorded by setCurrentUser at sign-in time. Null for identities
    // driven via the test driver (no prod analog for that path).
    const signInProvider = this.signInProviderByUid.get(uid) ?? null;
    const fullClaims: Record<string, unknown> = {
      sub: uid,
      aud: 'pyric-sandbox',
      iss: 'https://sandbox.pyric.dev',
      auth_time: Math.floor(issuedAt.getTime() / 1000),
      iat: Math.floor(issuedAt.getTime() / 1000),
      exp: Math.floor(expires.getTime() / 1000),
      ...claims,
      // Synthesized AFTER the custom-claims spread: `firebase` is a
      // reserved claim namespace in prod (custom claims can't shadow
      // it), so ours always wins. Mirrors the real JWT's
      // `firebase.sign_in_provider`.
      firebase: { sign_in_provider: signInProvider },
    };
    const result: IdTokenResult = {
      token,
      claims: fullClaims,
      expirationTime: expires.toISOString(),
      issuedAtTime: issuedAt.toISOString(),
      authTime: issuedAt.toISOString(),
      signInProvider,
    };
    return { token, result };
  }

  /**
   * Get-or-mint the ID token entry for a uid. `forceRefresh: true`
   * always mints a fresh token, overwrites the cache, and fires the
   * `onIdTokenChanged` listeners (NOT `onAuthStateChanged` — the
   * user identity didn't change). Matches prod oracle observations:
   *
   *   - `auth-getidtoken-force-refresh.json` — forceRefresh returns a
   *     different string than the previous read; a subsequent
   *     getIdToken(false) returns the new (cached) token.
   *   - `auth-onidtokenchanged-force-refresh.json` — onIdTokenChanged
   *     fires after a forced refresh.
   */
  getIdTokenFor(
    uid: string,
    claims: Record<string, unknown>,
    forceRefresh: boolean,
  ): string {
    if (forceRefresh) {
      const fresh = this.mintToken(uid, claims);
      this.tokenCache.set(uid, fresh);
      // Fan out to onIdTokenChanged listeners only — identity is
      // unchanged, so onAuthStateChanged stays silent.
      this.fanOut('id-token');
      return fresh.token;
    }
    const cached = this.tokenCache.get(uid);
    if (cached) return cached.token;
    const fresh = this.mintToken(uid, claims);
    this.tokenCache.set(uid, fresh);
    return fresh.token;
  }

  /** {@link getIdTokenFor} variant returning the full IdTokenResult.
   *  Same cache + fan-out semantics. */
  getIdTokenResultFor(
    uid: string,
    claims: Record<string, unknown>,
    forceRefresh: boolean,
  ): IdTokenResult {
    if (forceRefresh) {
      const fresh = this.mintToken(uid, claims);
      this.tokenCache.set(uid, fresh);
      this.fanOut('id-token');
      return fresh.result;
    }
    const cached = this.tokenCache.get(uid);
    if (cached) return cached.result;
    const fresh = this.mintToken(uid, claims);
    this.tokenCache.set(uid, fresh);
    return fresh.result;
  }

  /**
   * Build a `User` shell whose `getIdToken` / `getIdTokenResult`
   * route through the backend's token cache. The User object closes
   * over its uid + claims; the cache is owned by the backend so all
   * User instances for the same uid agree on the current token.
   */
  private makeUser(args: {
    uid: string;
    email: string | null;
    displayName: string | null;
    isAnonymous: boolean;
    claims: Record<string, unknown>;
    photoURL?: string | null;
    emailVerified?: boolean;
    phoneNumber?: string | null;
  }): User {
    const photoURL = args.photoURL ?? null;
    const phoneNumber = args.phoneNumber ?? null;
    // Sandbox has no email-verification flow; default to false unless the
    // caller explicitly supplied it (AUTH-GAP).
    const emailVerified = args.emailVerified ?? false;
    const providerId = 'firebase';
    // Synthesize a single provider entry from the user's own fields for
    // non-anonymous users (the email/password or popup provider);
    // anonymous users have no linked provider (AUTH-GAP).
    const providerData: UserInfo[] = args.isAnonymous
      ? []
      : [{
        uid: args.uid,
        displayName: args.displayName,
        email: args.email,
        phoneNumber,
        photoURL,
        providerId: 'password',
      }];
    const user: User = {
      uid: args.uid,
      email: args.email,
      emailVerified,
      displayName: args.displayName,
      photoURL,
      phoneNumber,
      isAnonymous: args.isAnonymous,
      providerId,
      providerData,
      // Read LIVE claims by uid on each token call (not the claims frozen
      // at mint time) so a `seedUsers` re-seed or an `updateUser` claims
      // change for this uid is reflected in a held user's
      // `getIdToken(true)` (AUTH-B10) — same propagation story as prod.
      // Falls back to the closed-over claims for users not in the DB
      // (anonymous / popup), matching how they were minted.
      getIdToken: async (forceRefresh?: boolean) =>
        this.getIdTokenFor(args.uid, this.liveClaims(args.uid, args.claims), forceRefresh === true),
      getIdTokenResult: async (forceRefresh?: boolean) =>
        this.getIdTokenResultFor(args.uid, this.liveClaims(args.uid, args.claims), forceRefresh === true),
    };
    // Stamp the backend-dispatch hook non-enumerably so the top-level
    // `updateProfile(user, …)` free function can update THIS user (and the
    // stored record) without an `auth` handle in scope, matching
    // `firebase/auth`'s `updateProfile(user, profile)` signature. Hidden
    // from enumeration/serialization so it never leaks into snapshots.
    Object.defineProperty(user, USER_INTERNAL, {
      value: {
        updateProfile: (p: { displayName?: string | null; photoURL?: string | null }) => {
          this.updateProfileFor(user, p);
          return Promise.resolve();
        },
      },
      enumerable: false,
    });
    return user;
  }

  /**
   * Update a signed-in user's profile (`displayName` / `photoURL`) — the
   * backend behind the top-level `updateProfile(user, profile)`.
   *
   * Updates the stored record, then mutates the passed `user` AND
   * `this.cachedUser` IN PLACE when their uid matches (the `User` fields are
   * TS-`readonly` but runtime-mutable, so held references — including
   * `auth.currentUser` — reflect the change without a re-read). Only a field
   * whose `profile.<field> !== undefined` is applied, so `null` clears and
   * `undefined` leaves the field untouched.
   *
   * Fires the coarse user-DB change (`notifyUsersChanged`) + a `user_update`
   * activity event, but does NOT fan out auth-state / id-token listeners:
   * real `firebase/auth.updateProfile` does not fire `onAuthStateChanged` /
   * `onIdTokenChanged`.
   */
  updateProfileFor(
    user: User,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): void {
    const stored = this.usersByUid.get(user.uid);
    const before = stored ? this.toRecord(stored) : undefined;
    if (stored) {
      if (profile.displayName !== undefined) stored.displayName = profile.displayName;
      if (profile.photoURL !== undefined) stored.photoUrl = profile.photoURL;
    }
    this.applyProfileToUser(user, profile);
    if (this.cachedUser && this.cachedUser.uid === user.uid && this.cachedUser !== user) {
      this.applyProfileToUser(this.cachedUser, profile);
    }
    this.notifyUsersChanged();
    this.emitAuthEvent('user_update', {
      path: user.uid,
      auth: { uid: user.uid },
      before,
      after: stored ? this.toRecord(stored) : undefined,
      detail: {
        displayName: profile.displayName,
        photoURL: profile.photoURL,
      },
    });
  }

  /** Mutate a `User`'s `displayName` / `photoURL` (and the first
   *  `providerData` entry's, when present) in place. `readonly` at the type
   *  level, mutable at runtime — cast through a Mutable helper. Only applies a
   *  field when it was explicitly provided (`!== undefined`). */
  private applyProfileToUser(
    user: User,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): void {
    const mutable = user as Mutable<User>;
    if (profile.displayName !== undefined) mutable.displayName = profile.displayName;
    if (profile.photoURL !== undefined) mutable.photoURL = profile.photoURL;
    const provider0 = user.providerData?.[0] as Mutable<UserInfo> | undefined;
    if (provider0) {
      if (profile.displayName !== undefined) provider0.displayName = profile.displayName;
      if (profile.photoURL !== undefined) provider0.photoURL = profile.photoURL;
    }
  }

  /**
   * Worker-path `updateProfile`: update the stored record for `uid`
   * (+ mutate `this.cachedUser` in place if it matches), then return the
   * refreshed {@link AuthUserRecord}. The worker holds the real per-port
   * session `User` and mutates it separately (host-auth.ts). Throws
   * `auth/user-not-found` for an unknown uid.
   */
  updateProfileByUid(
    uid: string,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): AuthUserRecord {
    const stored = this.usersByUid.get(uid);
    if (!stored) {
      throw makeAuthError('auth/user-not-found', `updateProfile: no identity with uid ${uid}.`);
    }
    const before = this.toRecord(stored);
    if (profile.displayName !== undefined) stored.displayName = profile.displayName;
    if (profile.photoURL !== undefined) stored.photoUrl = profile.photoURL;
    if (this.cachedUser && this.cachedUser.uid === uid) {
      this.applyProfileToUser(this.cachedUser, profile);
    }
    this.notifyUsersChanged();
    const after = this.toRecord(stored);
    this.emitAuthEvent('user_update', {
      path: uid,
      auth: { uid },
      before,
      after,
      detail: { displayName: profile.displayName, photoURL: profile.photoURL },
    });
    return after;
  }

  /** Live customClaims for a uid — the current value in the user DB,
   *  falling back to `fallback` for uids the DB doesn't track (anonymous
   *  / popup users). Used so a re-seed / `updateUser` is reflected in
   *  held users' forced-refresh tokens (AUTH-B10). */
  private liveClaims(
    uid: string,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.usersByUid.get(uid)?.customClaims ?? fallback;
  }

  /** Internal validator for email/password — checks the password
   *  matches the stored record. Throws `auth/invalid-email` on a
   *  malformed email, `auth/wrong-password` on mismatch,
   *  `auth/user-not-found` if the email isn't seeded.
   *
   *  Format validation fires BEFORE the user-DB lookup so callers
   *  shipping malformed inputs see the same `auth/invalid-email`
   *  prod returns — they wouldn't reach the missing-user path in
   *  production either. Password-strength is NOT enforced on sign-in
   *  (a previously-weak seeded password should still let the user
   *  in); only `createUserWithEmailAndPassword` runs the strength
   *  check, mirroring prod. */
  validatePassword(email: string, password: string): StoredUser {
    validateEmailFormat(email);
    // Empty password → `auth/missing-password`, fired BEFORE the user-DB
    // lookup (same anti-enumeration ordering as the email check). Prod's
    // signInWithPassword returns the MISSING_PASSWORD server error, mapped
    // to `auth/missing-password` with message "A non-empty password must
    // be provided" (`core/errors.ts:92,282,563`) — NOT wrong-password /
    // user-not-found (AUTH-B11).
    if (typeof password !== 'string' || password.length === 0) {
      throw makeAuthError(
        'auth/missing-password',
        'A non-empty password must be provided',
      );
    }
    const stored = this.findByEmail(email);
    if (!stored) {
      throw makeAuthError(
        'auth/user-not-found',
        `No user found for ${email}.`,
      );
    }
    // Disabled check BEFORE the password compare so a disabled
    // account can't be password-probed. Best-known semantics — the
    // exact prod ordering (disabled-vs-wrong-password) is flagged for
    // an oracle capture; the code (`auth/user-disabled`) and message
    // match prod's documented shape.
    if (stored.disabled) {
      throw makeAuthError(
        'auth/user-disabled',
        'The user account has been disabled by an administrator.',
      );
    }
    if (stored.password !== password) {
      throw makeAuthError(
        'auth/wrong-password',
        'Invalid password.',
      );
    }
    return stored;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Opaque token string. Hash is a tiny deterministic digest over the
 * serialized claims map + a monotonic serial — enough that two
 * different claim maps for the same uid get different tokens AND
 * back-to-back refreshes for the same uid + claims also get
 * different tokens. NOT a cryptographic primitive. The
 * `sandbox-id-token-` prefix is grepable in logs.
 */
function sandboxTokenFor(uid: string, claims: Record<string, unknown>, serial: number): string {
  let hash = 5381;
  const json = JSON.stringify(claims) + ':' + String(serial);
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `sandbox-id-token-${uid}-${hex}`;
}

/**
 * Empirical match for prod's email-format rejection (matrix row #18).
 * Prod uses a permissive regex — local-part + `@` + domain-with-dot
 * is the practical bar. We mirror that shape: reject empty, reject
 * missing `@`, reject empty local-part or empty domain-part. Anything
 * else passes; consumer code that ships a more exotic-but-valid
 * address (quoted local-parts, IDN domains, etc.) should still
 * round-trip the same as prod.
 *
 * Throws `auth/invalid-email` with a message matching prod's shape so
 * consumer code that switches on `.code` sees the same error in
 * sandbox + prod. Oracle observation:
 * `scripts/oracle/observations/auth-row-18-invalid-email-error-code.json`.
 */
function validateEmailFormat(email: string): void {
  if (typeof email !== 'string' || email.length === 0) {
    throw makeAuthError('auth/invalid-email', 'Error');
  }
  const atIdx = email.indexOf('@');
  // No `@`, or `@` at start (empty local-part), or `@` at end (empty
  // domain). Prod also rejects domains without a dot, but we stay
  // permissive there — the empirical oracle observation only locks
  // the `not-an-email` rejection.
  if (atIdx <= 0 || atIdx === email.length - 1) {
    throw makeAuthError('auth/invalid-email', 'Error');
  }
}

/**
 * Empirical match for prod's password-strength rejection (matrix
 * row #19). Prod's observed message is "Password should be at least
 * 6 characters" with code `auth/weak-password`. Oracle observation:
 * `scripts/oracle/observations/auth-row-19-weak-password-error-code.json`.
 */
function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 6) {
    throw makeAuthError(
      'auth/weak-password',
      'Password should be at least 6 characters',
    );
  }
}

/**
 * Build a real `FirebaseError` (the same class `firebase/auth` throws),
 * with the prod message wrapper `Firebase: <message> (<code>).`
 * (`clones/.../util/src/errors.ts:121` — `${serviceName}: ${message}
 * (${fullCode}).`, serviceName `Firebase`). So consumer code that does
 * `err instanceof FirebaseError` or matches on the wrapped message sees
 * the same shape sandbox vs prod (AUTH-GAP). `.code` is preserved.
 *
 * Oracle-pinned shapes this reproduces:
 *   - `Firebase: Error (auth/invalid-email).`
 *   - `Firebase: Password should be at least 6 characters (auth/weak-password).`
 */
export function makeAuthError(code: string, message: string): FirebaseError {
  return new FirebaseError(code, `Firebase: ${message} (${code}).`);
}

