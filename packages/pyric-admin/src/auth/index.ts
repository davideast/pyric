/**
 * `pyric-admin/auth` — the sandbox mirror for the Firebase Admin Auth shape.
 *
 * Mirrors `firebase-admin/auth` for a useful subset of methods. The
 * `app` argument is the branded handle from `pyric-admin/app`
 * ({@link PyricAdminApp}); only sandbox-branded apps enter this package.
 * The local sandbox path uses an in-memory store keyed off `app.sandbox`
 * and implements the core user-management subset below. Tokens are NOT
 * real JWTs — they are deterministic strings parsed by the same sandbox
 * backend. This is enough to exercise agent code paths that use
 * `createUser` / `getUser` / `setCustomUserClaims` /
 * `createCustomToken` / `verifyIdToken`, not enough to model a real
 * identity platform.
 *
 *   - **Remote sandbox arm** — when the sandbox carries `pyric/sandbox`'s
 *     remote brand (a Node-side handle onto the browser-hosted
 *     SharedWorker sandbox from `@pyric/cli`' `connectRemoteSandbox()`),
 *     user CRUD relays over the handle's worker channel instead of the
 *     in-memory store, so server-created users land in the ONE user pool
 *     the browser app + Studio share. See the "Remote sandbox arm"
 *     section below for the details (including the extra methods it
 *     supports: `updateUser`, `listUsers`).
 *
 * Surface scope on the sandbox backend (what works):
 *
 *   - {@link getAuth}
 *   - `Auth.createCustomToken(uid, claims?)` — returns a deterministic
 *     `pyric-sandbox-custom:${uid}:${json}` string; no signing.
 *   - `Auth.verifyIdToken(token)` — parses tokens minted by
 *     `createCustomToken`; returns a {@link DecodedIdToken}-shaped
 *     object.
 *   - `Auth.createUser(properties)` — stores a {@link UserRecord}
 *     in an in-memory `Map<uid, UserRecord>`. Auto-generates a `uid`
 *     when one is not supplied.
 *   - `Auth.getUser(uid)` — Map lookup.
 *   - `Auth.getUserByEmail(email)` — linear scan.
 *   - `Auth.deleteUser(uid)` — Map delete.
 *   - `Auth.setCustomUserClaims(uid, claims)` — updates the stored
 *     `UserRecord.customClaims`.
 *
 * Sandbox backend — explicitly NOT implemented (throws
 * `'not implemented in pyric-admin/auth sandbox backend'` so callers
 * get a clear remediation message):
 *
 *   - Tenancy: `tenantManager` and any per-tenant call.
 *   - Identity providers: `createProviderConfig`, `getProviderConfig`,
 *     `listProviderConfigs`, `updateProviderConfig`,
 *     `deleteProviderConfig`.
 *   - Multi-factor: `MultiFactorSettings` on UserRecord is always
 *     `undefined`; MFA enrollment is unsupported.
 *   - Session cookies: `createSessionCookie`, `verifySessionCookie`.
 *   - Action codes / password reset / email link sign-in:
 *     `generatePasswordResetLink`, `generateEmailVerificationLink`,
 *     `generateSignInWithEmailLink`, `generateVerifyAndChangeEmailLink`.
 *   - Bulk operations: `listUsers`, `getUsers`, `deleteUsers`,
 *     `importUsers`.
 *   - Revocation: `revokeRefreshTokens`.
 *   - `getUserByPhoneNumber`, `getUserByProviderUid`.
 *   - `updateUser` — not required by the brief.
 *
 * Public types are mirror-owned structural types. Production applications
 * load `firebase-admin/auth` directly, outside this package graph.
 */
import {
  isRemoteSandbox,
  type RemoteSandbox,
  type Sandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import type {
  AuthUserRecord,
  CreateUserRequest as SandboxCreateUserRequest,
  UpdateUserRequest as SandboxUpdateUserRequest,
} from 'pyric/auth';
import {
  ADMIN_APP_TARGET,
  getApp,
  type PyricAdminApp,
} from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';

export interface CreateRequest {
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  disabled?: boolean;
  password?: string;
}

export interface UpdateRequest extends Omit<CreateRequest, 'uid'> {
  multiFactor?: unknown;
  providerToLink?: unknown;
  providersToUnlink?: unknown;
}

export interface DecodedIdToken extends Record<string, unknown> {
  aud: string;
  auth_time: number;
  exp: number;
  firebase: { identities: Record<string, unknown>; sign_in_provider: string };
  iat: number;
  iss: string;
  sub: string;
  uid: string;
}

export interface UserMetadata {
  creationTime: string;
  lastSignInTime: string;
  toJSON(): Record<string, unknown>;
}

export interface UserInfo {
  providerId: string;
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  phoneNumber?: string;
  toJSON(): Record<string, unknown>;
}

export interface UserRecord {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
  readonly disabled: boolean;
  readonly metadata: UserMetadata;
  readonly providerData: UserInfo[];
  readonly customClaims?: Record<string, unknown>;
  readonly tenantId: string | null;
  toJSON(): Record<string, unknown>;
}

export interface ListUsersResult {
  users: UserRecord[];
  pageToken?: string;
}

/** Sandbox Auth interface intentionally limited to implemented behavior. */
export interface Auth {
  readonly app: PyricAdminApp;
  createCustomToken(uid: string, developerClaims?: object): Promise<string>;
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  createUser(properties: CreateRequest): Promise<UserRecord>;
  getUser(uid: string): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord>;
  deleteUser(uid: string): Promise<void>;
  setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void>;
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
  [key: string]: unknown;
}

// ─── Sandbox backend ────────────────────────────────────────────────────

/**
 * Per-sandbox in-memory store. One instance per `Sandbox` (tracked in
 * the {@link sandboxStores} WeakMap below). Holds the user table; the
 * token format is stateless (`createCustomToken` mints, `verifyIdToken`
 * parses) so it doesn't need to live here.
 *
 * `usersByUid` is the canonical index. `getUserByEmail` does a linear
 * scan over its values — the sandbox is for development and agent test
 * runs, not production traffic, so an extra index isn't worth the
 * write-path complexity.
 */
class AuthStore {
  readonly usersByUid = new Map<string, UserRecord>();
  /** Monotonic counter for auto-generated uids. Reset along with the
   *  user map when the sandbox calls `reset()`. */
  private nextAutoUid = 1;

  /**
   * Mint an auto-uid in the same shape Firebase Auth uses (28 chars,
   * URL-safe alphabet). The sandbox doesn't need cryptographic
   * collision resistance — it needs a stable, debuggable identifier
   * that doesn't collide *within one sandbox session*. A counter plus
   * a constant prefix is enough; padding keeps the visual width
 * roughly consistent with Firebase Auth uids.
   */
  mintUid(): string {
    const n = String(this.nextAutoUid++).padStart(20, '0');
    return `pyric-sandbox-${n}`;
  }

  /** Wipe state. Called on `sandbox.reset()`. */
  clear(): void {
    this.usersByUid.clear();
    this.nextAutoUid = 1;
  }
}

/**
 * One {@link AuthStore} per `Sandbox`. WeakMap so a sandbox that gets
 * GC'd by its host takes its auth state with it — no manual disposal
 * needed.
 */
const sandboxStores = new WeakMap<Sandbox, AuthStore>();

/**
 * Tracks which sandboxes already have a `session_boundary` listener
 * attached. Without this guard, calling `getAuth(app)` twice for the
 * same sandbox would register two listeners that each clear the store
 * on reset — harmless functionally, but a noisy leak.
 */
const sandboxesWithReset = new WeakSet<Sandbox>();

/**
 * Get-or-create the auth store for a sandbox, and on first creation
 * subscribe to `session_boundary` events so the store wipes itself when
 * the sandbox is reset. The subscription is attached once per sandbox.
 *
 * `dispose` is also a session boundary; we clear on either phase so a
 * disposed-and-replaced sandbox doesn't hand its successor stale state.
 * (In practice WeakMap GC handles that, but clearing eagerly costs
 * nothing.)
 */
function storeFor(sandbox: Sandbox): AuthStore {
  let store = sandboxStores.get(sandbox);
  if (store) return store;
  store = new AuthStore();
  sandboxStores.set(sandbox, store);
  if (!sandboxesWithReset.has(sandbox)) {
    sandboxesWithReset.add(sandbox);
    sandbox.onEvent((event: SandboxEvent) => {
      if (event.kind === 'session_boundary') {
        store!.clear();
      }
    });
  }
  return store;
}

/**
 * Token format minted by `createCustomToken` and parsed by
 * `verifyIdToken`. Exported as a constant so tests can lock the shape.
 *
 * Layout: `pyric-sandbox-custom:${uid}:${jsonClaims}`
 *
 * - The prefix lets `verifyIdToken` reject foreign tokens with a clear
 *   "not a sandbox token" error rather than NaN'ing out.
 * - `uid` is colon-free per the auto-uid format above.
 * - `jsonClaims` is the JSON-stringified developer claims (or `{}` when
 *   none were provided). Round-trips losslessly through `JSON.parse`.
 *
 * NOT a JWT. NOT signed. Do not use this token format to talk to any
 * real Firebase service — it only round-trips through this same
 * sandbox backend.
 */
export const SANDBOX_TOKEN_PREFIX = 'pyric-sandbox-custom';

/**
 * Mint a deterministic sandbox token (the {@link SANDBOX_TOKEN_PREFIX}
 * format). Stateless — shared verbatim by the local and remote sandbox
 * arms, so a token minted against either round-trips through
 * {@link verifySandboxIdToken} on the other.
 */
function mintSandboxCustomToken(uid: string, developerClaims?: object): Promise<string> {
  const claims = developerClaims ?? {};
  const token = `${SANDBOX_TOKEN_PREFIX}:${uid}:${JSON.stringify(claims)}`;
  return Promise.resolve(token);
}

/**
 * Parse a token minted by {@link mintSandboxCustomToken}. Returns a
 * `DecodedIdToken`-shaped object — every required field is filled with a
 * sandbox-appropriate placeholder (`iss`/`aud` = `pyric-sandbox`, time
 * fields = now), and the developer claims are spread onto the result so
 * `decoded.role` etc. retain the familiar Firebase Admin shape.
 *
 * Throws on any token that doesn't match the
 * `${SANDBOX_TOKEN_PREFIX}:${uid}:${json}` shape — including real JWTs
 * that another verifier would parse. The sandbox backends are
 * intentionally not drop-ins for production token verification.
 */
function verifySandboxIdToken(idToken: string): Promise<DecodedIdToken> {
  if (typeof idToken !== 'string' || !idToken.startsWith(`${SANDBOX_TOKEN_PREFIX}:`)) {
    return Promise.reject(
      new Error(
        'pyric-admin/auth: verifyIdToken on the sandbox backend only ' +
          'accepts tokens minted by this sandbox\'s createCustomToken. ' +
          `Token prefix must be "${SANDBOX_TOKEN_PREFIX}:".`,
      ),
    );
  }
  // The token is `prefix:uid:json`. Split on the first two colons
  // only — the JSON payload may itself contain colons (e.g. inside
  // a string value) so `split(':')` with no limit would corrupt it.
  const firstColon = idToken.indexOf(':');
  const secondColon = idToken.indexOf(':', firstColon + 1);
  if (secondColon < 0) {
    return Promise.reject(
      new Error(
        `pyric-admin/auth: verifyIdToken received a malformed sandbox token (missing claims segment): ${idToken}`,
      ),
    );
  }
  const uid = idToken.slice(firstColon + 1, secondColon);
  const jsonClaims = idToken.slice(secondColon + 1);
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(jsonClaims) as Record<string, unknown>;
  } catch (e) {
    return Promise.reject(
      new Error(
        `pyric-admin/auth: verifyIdToken failed to parse sandbox token claims as JSON: ${(e as Error).message}`,
      ),
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // `DecodedIdToken` requires `aud`/`iss`/`sub`/`uid`/`auth_time`/
  // `exp`/`iat`/`firebase` to be present; the sandbox fills them
  // with placeholders so consumers that read them get sensible
  // values rather than `undefined`. Developer claims are spread on
  // top so they shadow nothing critical.
  const decoded: DecodedIdToken = {
    aud: 'pyric-sandbox',
    auth_time: nowSec,
    exp: nowSec + 3600,
    firebase: {
      identities: {},
      sign_in_provider: 'custom',
    },
    iat: nowSec,
    iss: 'pyric-sandbox',
    sub: uid,
    uid,
    ...claims,
  };
  return Promise.resolve(decoded);
}

/**
 * Build the in-memory `Auth` handle for a sandbox app. Returns an
 * object structurally compatible with `firebase-admin/auth`'s `Auth`
 * (cast at the boundary) where the documented method subset is wired
 * to the in-memory store and everything else throws the canonical
 * `not implemented in pyric-admin/auth sandbox backend` error.
 *
 * The cast-to-`Auth` at the return is deliberate — `firebase-admin`'s
 * `Auth` is a large class surface (tenants, providers, MFA, session
 * cookies) that this backend doesn't model. Implementing the entire
 * surface as throwing stubs would be ~30 unused methods of noise; the
 * cast acknowledges the divergence in one place and lets the rest of
 * the file focus on the methods that actually work.
 */
function makeSandboxAuth(sandbox: Sandbox): Auth {
  const store = storeFor(sandbox);

  /** Canonical "not implemented" error for surface that the sandbox
   *  backend doesn't model. Threaded through every stub so the message
   *  is identical wherever it's hit. */
  const notImplemented = (method: string): Error =>
    new Error(
      `pyric-admin/auth: ${method} is not implemented in pyric-admin/auth sandbox backend`,
    );

  /**
   * Convert a `CreateRequest` to a `UserRecord`. `firebase-admin`'s
   * `UserRecord` is a class with `readonly` fields; we build a plain
   * object with the same shape and cast it. The sandbox doesn't need
   * the class's `toJSON()` or its provider-merging logic — it needs the
   * field set that the documented method subset reads back.
   *
   * Defaults match upstream defaults: `emailVerified: false`,
   * `disabled: false`, empty `providerData`, present `metadata` with
   * sandbox-current timestamps.
   */
  const toUserRecord = (
    uid: string,
    props: CreateRequest,
    customClaims?: Record<string, unknown>,
  ): UserRecord => {
    const now = new Date().toUTCString();
    const record: Partial<UserRecord> = {
      uid,
      email: props.email,
      emailVerified: props.emailVerified ?? false,
      displayName: props.displayName ?? undefined,
      photoURL: props.photoURL ?? undefined,
      phoneNumber: props.phoneNumber ?? undefined,
      disabled: props.disabled ?? false,
      metadata: {
        creationTime: now,
        lastSignInTime: '',
        toJSON: () => ({ creationTime: now, lastSignInTime: '' }),
      } as UserRecord['metadata'],
      providerData: [],
      customClaims,
      tenantId: null,
      toJSON: () => ({ uid, email: props.email }),
    };
    return record as UserRecord;
  };

  // The handle. Methods that round-trip to the store are real; the
  // rest throw via `notImplemented`. Cast to `Auth` at return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle: any = {
    /** Preserve the upstream `auth.app` property shape while failing loudly
     *  because the minimal local backend does not expose an app handle. */
    get app() {
      throw notImplemented('auth.app');
    },

    /**
     * Mint a deterministic sandbox token. Format is fixed at
     * `${SANDBOX_TOKEN_PREFIX}:${uid}:${JSON.stringify(claims ?? {})}`.
     * Round-trips through {@link verifyIdToken} on the same sandbox
     * backend; rejected by every other token verifier. Shared
     * implementation: {@link mintSandboxCustomToken}.
     */
    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      return mintSandboxCustomToken(uid, developerClaims);
    },

    /**
     * Parse a token minted by {@link createCustomToken}. Shared
     * implementation: {@link verifySandboxIdToken}.
     */
    verifyIdToken(idToken: string, _checkRevoked?: boolean): Promise<DecodedIdToken> {
      return verifySandboxIdToken(idToken);
    },

    /**
     * Store a {@link UserRecord} in the in-memory map. If the caller
     * supplied a `uid`, it's used as-is (and a conflict throws
     * `auth/uid-already-exists`-style); otherwise a sandbox-shaped
     * uid is minted.
     */
    createUser(properties: CreateRequest): Promise<UserRecord> {
      const uid = properties.uid ?? store.mintUid();
      if (store.usersByUid.has(uid)) {
        return Promise.reject(
          new Error(
            `pyric-admin/auth: createUser failed — uid "${uid}" already exists in the sandbox auth store`,
          ),
        );
      }
      const record = toUserRecord(uid, properties);
      store.usersByUid.set(uid, record);
      return Promise.resolve(record);
    },

    /** Map lookup; rejects with a `user-not-found` message on miss. */
    getUser(uid: string): Promise<UserRecord> {
      const record = store.usersByUid.get(uid);
      if (!record) {
        return Promise.reject(
          new Error(`pyric-admin/auth: getUser failed — no user with uid "${uid}"`),
        );
      }
      return Promise.resolve(record);
    },

    /** Linear scan. Sandbox-scale data only — see class JSDoc. */
    getUserByEmail(email: string): Promise<UserRecord> {
      for (const record of store.usersByUid.values()) {
        if (record.email === email) return Promise.resolve(record);
      }
      return Promise.reject(
        new Error(`pyric-admin/auth: getUserByEmail failed — no user with email "${email}"`),
      );
    },

    /** Idempotent: removing a nonexistent uid is a no-op (matches
     *  upstream's "successful response" behavior on missing users for
     *  the admin SDK's delete semantics — the SDK does throw, but the
     *  test fixtures consume the throw as a non-fatal). We throw on
     *  miss to match upstream's stricter contract on `deleteUser`. */
    deleteUser(uid: string): Promise<void> {
      if (!store.usersByUid.has(uid)) {
        return Promise.reject(
          new Error(`pyric-admin/auth: deleteUser failed — no user with uid "${uid}"`),
        );
      }
      store.usersByUid.delete(uid);
      return Promise.resolve();
    },

    /**
     * Update the stored UserRecord's `customClaims`. Passing `null`
     * clears them (matches the upstream contract:
     * `customUserClaims: object | null`).
     *
     * The UserRecord is rewritten — `customClaims` is `readonly` on
     * the upstream type, so an in-place mutation would type-error.
     * We rebuild the record from the prior props and the new claims,
     * preserving every other field.
     */
    setCustomUserClaims(
      uid: string,
      customUserClaims: object | null,
    ): Promise<void> {
      const prior = store.usersByUid.get(uid);
      if (!prior) {
        return Promise.reject(
          new Error(
            `pyric-admin/auth: setCustomUserClaims failed — no user with uid "${uid}"`,
          ),
        );
      }
      const updated = {
        ...prior,
        customClaims:
          customUserClaims === null
            ? undefined
            : (customUserClaims as Record<string, unknown>),
        toJSON: prior.toJSON.bind(prior),
      } as UserRecord;
      store.usersByUid.set(uid, updated);
      return Promise.resolve();
    },

    // ─── Explicitly-not-implemented surface ─────────────────────────
    //
    // The rest of `BaseAuth` (and `Auth`) — tenants, providers, MFA,
    // session cookies, action codes, bulk ops, refresh-token
    // revocation, phone/provider lookups, `updateUser`. Each throws
    // the canonical `not implemented in pyric-admin/auth sandbox
    // backend` error so the caller knows the surface exists upstream
    // but isn't modelled here.

    updateUser(): Promise<UserRecord> {
      return Promise.reject(notImplemented('updateUser'));
    },
    getUserByPhoneNumber(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('deleteUsers'));
    },
    listUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('listUsers'));
    },
    importUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('importUsers'));
    },
    revokeRefreshTokens(): Promise<void> {
      return Promise.reject(notImplemented('revokeRefreshTokens'));
    },
    createSessionCookie(): Promise<string> {
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(): Promise<DecodedIdToken> {
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(): Promise<string> {
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(): Promise<string> {
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateVerifyAndChangeEmailLink'));
    },
    createProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('createProviderConfig'));
    },
    getProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('getProviderConfig'));
    },
    listProviderConfigs(): Promise<unknown> {
      return Promise.reject(notImplemented('listProviderConfigs'));
    },
    updateProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('updateProviderConfig'));
    },
    deleteProviderConfig(): Promise<void> {
      return Promise.reject(notImplemented('deleteProviderConfig'));
    },
    get tenantManager(): never {
      throw notImplemented('tenantManager');
    },
    get projectConfigManager(): never {
      throw notImplemented('projectConfigManager');
    },
  };
  return handle as Auth;
}

// ─── Remote sandbox arm (remote sandbox, slice 1) ───────────────────────
//
// The app's `Sandbox` is a Node-side handle onto the browser-hosted
// SharedWorker sandbox (`pyric/sandbox`'s remote brand). User CRUD relays
// over the handle's worker channel as the existing admin auth ops
// (`auth.adminCreateUser` / `auth.adminUpdateUser` / `auth.adminDeleteUser`
// / `auth.listUsers`) so server-created users land in the ONE user pool
// the browser app + Studio + agents share — an in-memory `AuthStore` keyed
// off a remote handle would be a private user table the browser never
// sees. Auth ops are never lensed (they operate the worker's user pool
// directly), so no `actAs` is pinned here, unlike the RTDB arm.
//
// Single-user lookups (`getUser` / `getUserByEmail`) go through
// `auth.listUsers` + a client-side filter: the worker protocol has no
// dedicated single-lookup op, and O(n) over the wire is fine at sandbox
// scale (per the design spike — add an op if it ever matters).
//
// Tokens stay stateless and local: `createCustomToken` / `verifyIdToken`
// are the same string transforms as the local arm
// ({@link mintSandboxCustomToken} / {@link verifySandboxIdToken}), so a
// token minted server-side verifies against any pyric-admin backend.

/** Map a firebase-admin `CreateRequest` onto the worker's sandbox
 *  create-user request. `null`s (upstream "clear") become "unset" — a
 *  fresh user has nothing to clear. `multiFactor` isn't modeled. */
function toSandboxCreateRequest(props: CreateRequest): SandboxCreateUserRequest {
  return {
    uid: props.uid,
    email: props.email,
    password: props.password,
    displayName: props.displayName ?? undefined,
    phoneNumber: props.phoneNumber ?? undefined,
    photoUrl: props.photoURL ?? undefined,
    disabled: props.disabled,
    emailVerified: props.emailVerified,
  };
}

/** Convert the worker's `AuthUserRecord` (emulator-REST-shaped, from
 *  `pyric/auth`) into a firebase-admin `UserRecord`-shaped object — the
 *  same field set the local arm's `toUserRecord` fills. */
function fromAuthUserRecord(r: AuthUserRecord): UserRecord {
  const metadata = {
    creationTime: r.createdAt,
    lastSignInTime: r.lastLoginAt ?? '',
    toJSON: () => ({ creationTime: r.createdAt, lastSignInTime: r.lastLoginAt ?? '' }),
  } as UserRecord['metadata'];
  const record: Partial<UserRecord> = {
    uid: r.uid,
    email: r.email ?? undefined,
    emailVerified: r.emailVerified,
    displayName: r.displayName ?? undefined,
    photoURL: r.photoUrl ?? undefined,
    phoneNumber: r.phoneNumber ?? undefined,
    disabled: r.disabled,
    metadata,
    providerData: r.providerUserInfo.map((p) => ({
      providerId: p.providerId,
      uid: r.uid,
      displayName: r.displayName ?? undefined,
      email: r.email ?? undefined,
      photoURL: r.photoUrl ?? undefined,
      phoneNumber: r.phoneNumber ?? undefined,
      toJSON: () => ({ providerId: p.providerId, uid: r.uid }),
    })) as unknown as UserRecord['providerData'],
    customClaims:
      Object.keys(r.customClaims).length > 0
        ? (r.customClaims as Record<string, unknown>)
        : undefined,
    tenantId: null,
    toJSON: () => ({ uid: r.uid, email: r.email ?? undefined }),
  };
  return record as UserRecord;
}

/**
 * Build the remote `Auth` handle: the documented CRUD subset relays over
 * the worker channel; tokens are the shared stateless transforms; the
 * rest of the surface throws the canonical "not implemented" error (same
 * cast-at-the-boundary rationale as {@link makeSandboxAuth}).
 *
 * Differences from the local in-memory arm, all deliberate:
 *   - `updateUser` and `listUsers` WORK (the worker has the ops; the
 *     local arm predates them and still throws).
 *   - User mutations emit auth `SandboxEvent`s in the worker (visible to
 *     Studio/agents) and are visible to the browser app immediately.
 */
function makeRemoteAuth(sandbox: RemoteSandbox): Auth {
  const channel = sandbox.channel;

  const notImplemented = (method: string): Error =>
    new Error(
      `pyric-admin/auth: ${method} is not implemented in pyric-admin/auth remote sandbox backend`,
    );

  const listRecords = async (): Promise<AuthUserRecord[]> =>
    (await channel.op({ method: 'auth.listUsers' })) as AuthUserRecord[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle: any = {
    get app() {
      throw notImplemented('auth.app');
    },

    /** Stateless mint — identical to the local arm; needs no relay. */
    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      return mintSandboxCustomToken(uid, developerClaims);
    },

    /** Stateless parse — identical to the local arm; needs no relay. */
    verifyIdToken(idToken: string, _checkRevoked?: boolean): Promise<DecodedIdToken> {
      return verifySandboxIdToken(idToken);
    },

    /** Relays `auth.adminCreateUser`. Uid conflicts / invalid emails /
     *  weak passwords reject with the worker backend's `auth/*` error. */
    async createUser(properties: CreateRequest): Promise<UserRecord> {
      const record = await channel.op({
        method: 'auth.adminCreateUser',
        request: toSandboxCreateRequest(properties) as unknown as Record<string, unknown>,
      });
      return fromAuthUserRecord(record as AuthUserRecord);
    },

    /** `auth.listUsers` + client-side filter (see module note). */
    async getUser(uid: string): Promise<UserRecord> {
      const record = (await listRecords()).find((u) => u.uid === uid);
      if (!record) {
        throw new Error(`pyric-admin/auth: getUser failed — no user with uid "${uid}"`);
      }
      return fromAuthUserRecord(record);
    },

    /** `auth.listUsers` + client-side filter (see module note). */
    async getUserByEmail(email: string): Promise<UserRecord> {
      const record = (await listRecords()).find((u) => u.email === email);
      if (!record) {
        throw new Error(
          `pyric-admin/auth: getUserByEmail failed — no user with email "${email}"`,
        );
      }
      return fromAuthUserRecord(record);
    },

    /** Relays `auth.listUsers`. The whole pool fits one page at sandbox
     *  scale, so `pageToken` is never set; `maxResults` is honored. */
    async listUsers(maxResults?: number, _pageToken?: string): Promise<ListUsersResult> {
      let records = await listRecords();
      if (maxResults !== undefined) records = records.slice(0, maxResults);
      return { users: records.map(fromAuthUserRecord) } as ListUsersResult;
    },

    /**
     * Relays `auth.adminUpdateUser` for the fields the worker models
     * (`displayName` / `email` / `password` / `disabled` /
     * `emailVerified`). Fields it can't express (`photoURL`,
     * `phoneNumber`, `multiFactor`, provider links) throw rather than
     * silently dropping a requested change.
     */
    async updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
      const unsupported = (['photoURL', 'phoneNumber', 'multiFactor', 'providerToLink', 'providersToUnlink'] as const).filter(
        (k) => (properties as Record<string, unknown>)[k] !== undefined,
      );
      if (unsupported.length > 0) {
        throw notImplemented(`updateUser({ ${unsupported.join(', ')} })`);
      }
      const request: SandboxUpdateUserRequest = {
        displayName: properties.displayName,
        email: properties.email,
        password: properties.password,
        disabled: properties.disabled,
        emailVerified: properties.emailVerified,
      };
      const record = await channel.op({
        method: 'auth.adminUpdateUser',
        uid,
        request: request as unknown as Record<string, unknown>,
      });
      return fromAuthUserRecord(record as AuthUserRecord);
    },

    /** Relays `auth.adminDeleteUser`. A missing uid rejects with the
     *  worker backend's `auth/user-not-found` error (matches upstream's
     *  strict delete contract, like the local arm). */
    async deleteUser(uid: string): Promise<void> {
      await channel.op({ method: 'auth.adminDeleteUser', uid });
    },

    /** Relays `auth.adminUpdateUser` with a `customClaims` replacement —
     *  `null` clears (the worker's UpdateUserRequest.customClaims
     *  replaces the whole map, admin `setCustomUserClaims` semantics). */
    async setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void> {
      await channel.op({
        method: 'auth.adminUpdateUser',
        uid,
        request: { customClaims: customUserClaims ?? {} },
      });
    },

    // ─── Explicitly-not-implemented surface (parity with local) ──────

    getUserByPhoneNumber(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('deleteUsers'));
    },
    importUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('importUsers'));
    },
    revokeRefreshTokens(): Promise<void> {
      return Promise.reject(notImplemented('revokeRefreshTokens'));
    },
    createSessionCookie(): Promise<string> {
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(): Promise<DecodedIdToken> {
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(): Promise<string> {
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(): Promise<string> {
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateVerifyAndChangeEmailLink'));
    },
    createProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('createProviderConfig'));
    },
    getProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('getProviderConfig'));
    },
    listProviderConfigs(): Promise<unknown> {
      return Promise.reject(notImplemented('listProviderConfigs'));
    },
    updateProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('updateProviderConfig'));
    },
    deleteProviderConfig(): Promise<void> {
      return Promise.reject(notImplemented('deleteProviderConfig'));
    },
    get tenantManager(): never {
      throw notImplemented('tenantManager');
    },
    get projectConfigManager(): never {
      throw notImplemented('projectConfigManager');
    },
  };
  return handle as Auth;
}

// ─── Sandbox selection ──────────────────────────────────────────────────

/**
 * Return an `Auth` handle for the given app — or for the DEFAULT app when
 * called with no argument (mirrors firebase-admin's no-arg `getAuth()`:
 * resolves `'[DEFAULT]'` through `pyric-admin/app`'s registry and throws
 * `app/no-app` when nothing has been initialized). Local sandboxes use the
 * in-memory store; remote sandboxes relay to the browser-hosted worker.
 *
 * @example
 * ```ts
 * import { initializeApp } from 'pyric-admin/app';
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAuth } from 'pyric-admin/auth';
 *
 * const sandbox = initializeSandbox();
 * const app = initializeApp({ sandbox });
 * const auth = getAuth(app);
 *
 * const user = await auth.createUser({ uid: 'alice', email: 'a@e.com' });
 * const token = await auth.createCustomToken(user.uid, { role: 'admin' });
 * const decoded = await auth.verifyIdToken(token);
 * console.log(decoded.uid, decoded.role); // 'alice' 'admin'
 * ```
 */
export function getAuth(app?: PyricAdminApp): Auth {
  if (app === undefined) {
    // No-arg mirror of firebase-admin's `getAuth()` — resolve the
    // '[DEFAULT]' app from the registry (throws app/no-app on a miss).
    app = getApp();
  }
  if (app === null || typeof app !== 'object' || !(ADMIN_APP_TARGET in app)) {
    throw new TypeError(
      'pyric-admin/auth: getAuth expected a PyricAdminApp (from pyric-admin/app#initializeApp). ' +
        'Received a value with no ADMIN_APP_TARGET brand. Pass the handle returned by ' +
        '`initializeApp({ sandbox })`.',
    );
  }
  assertAdminAppActive(app);
  if (app[ADMIN_APP_TARGET] !== 'sandbox') {
    throw new TypeError('pyric-admin/auth: getAuth expected a sandbox admin app.');
  }
  return isRemoteSandbox(app.sandbox)
    ? makeRemoteAuth(app.sandbox)
    : makeSandboxAuth(app.sandbox);
}
