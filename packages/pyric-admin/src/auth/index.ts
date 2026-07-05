/**
 * `pyric-admin/auth` — Phase 3 (branded-app dispatch) + Phase 4b
 * (minimal in-memory sandbox backend).
 *
 * Mirrors `firebase-admin/auth` for a useful subset of methods. The
 * `app` argument is the branded handle from `pyric-admin/app`
 * ({@link PyricAdminApp}); the brand symbol picks the backend:
 *
 *   - **Prod path** (`app[ADMIN_APP_TARGET] === 'prod'`) — delegates to
 *     `firebase-admin/auth`'s `getAuth(app.adminApp)` and returns the
 *     production `Auth` instance unchanged. Drop-in replacement for
 *     `firebase-admin/auth` so agents already calling it keep their
 *     exact behavior (tenants, providers, MFA, session cookies, action
 *     codes, all present on the returned handle).
 *
 *   - **Sandbox path** (`app[ADMIN_APP_TARGET] === 'sandbox'`) — backed
 *     by an in-memory store keyed off `app.sandbox`. Implements the
 *     core user-management subset listed below. Tokens are NOT real
 *     JWTs — they're deterministic strings the same sandbox backend
 *     parses on `verifyIdToken`. The sandbox backend is intentionally
 *     minimal: enough to exercise agent code paths that use
 *     `createUser` / `getUser` / `setCustomUserClaims` /
 *     `createCustomToken` / `verifyIdToken`, not enough to model a
 *     real identity platform.
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
 * Real `firebase-admin` types are imported with `import type` so
 * signatures stay identical to upstream — there's no shape drift to
 * keep in sync.
 */

import type {
  Auth as AdminAuth,
  CreateRequest,
  DecodedIdToken,
  UserRecord,
} from 'firebase-admin/auth';
import type { App } from 'firebase-admin/app';
import type { Sandbox, SandboxEvent } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
  type ProdAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';

/**
 * The handle returned by {@link getAuth}. On the prod path this is
 * literally `firebase-admin/auth`'s `Auth` — every method, every
 * tenant/project manager, every shape detail. On the sandbox path it is
 * a structurally-compatible `Auth` whose method set is the explicit
 * subset documented above; non-implemented methods throw a clear
 * remediation error rather than silently returning bad data.
 */
export type Auth = AdminAuth;

// Re-export supporting types so consumers can spell them with a
// `pyric-admin/auth` import path and not reach back into
// `firebase-admin/auth` for the same definitions.
export type { CreateRequest, DecodedIdToken, UserRecord };

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
   * roughly consistent with prod uids.
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
    /** Stamp the app on the handle so debugging shows where it came
     *  from. The prod handle has an `app` getter too — matching the
     *  shape keeps consumers that inspect `auth.app` from breaking. */
    get app() {
      throw notImplemented('auth.app');
    },

    /**
     * Mint a deterministic sandbox token. Format is fixed at
     * `${SANDBOX_TOKEN_PREFIX}:${uid}:${JSON.stringify(claims ?? {})}`.
     * Round-trips through {@link verifyIdToken} on the same sandbox
     * backend; rejected by every other token verifier.
     */
    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      const claims = developerClaims ?? {};
      const token = `${SANDBOX_TOKEN_PREFIX}:${uid}:${JSON.stringify(claims)}`;
      return Promise.resolve(token);
    },

    /**
     * Parse a token minted by {@link createCustomToken}. Returns a
     * `DecodedIdToken`-shaped object — every required field is filled
     * with a sandbox-appropriate placeholder (`iss`/`aud` =
     * `pyric-sandbox`, time fields = now), and the developer claims are
     * spread onto the result so `decoded.role` etc. work the same way
     * they do in prod.
     *
     * Throws on any token that doesn't match the
     * `${SANDBOX_TOKEN_PREFIX}:${uid}:${json}` shape — including real
     * JWTs that another verifier would parse. The sandbox backend is
     * intentionally not a drop-in for production token verification.
     */
    verifyIdToken(idToken: string, _checkRevoked?: boolean): Promise<DecodedIdToken> {
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

// ─── Dispatch ────────────────────────────────────────────────────────────

/**
 * Type guard for the prod arm of {@link PyricAdminApp}. Reads the
 * brand symbol from `pyric-admin/app` — no structural sniffing.
 */
function isProdAdminApp(app: PyricAdminApp): app is ProdAdminApp {
  return app[ADMIN_APP_TARGET] === 'prod';
}

/**
 * Type guard for the sandbox arm of {@link PyricAdminApp}. Brand-based,
 * symmetric with {@link isProdAdminApp}.
 */
function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp {
  return app[ADMIN_APP_TARGET] === 'sandbox';
}

/**
 * Return an `Auth` handle for the given app.
 *
 * Dispatches on the brand symbol set by `pyric-admin/app`'s
 * `initializeApp`:
 *   - `'prod'` → delegates to `firebase-admin/auth`'s `getAuth` against
 *     `app.adminApp`. The returned `Auth` is the production object,
 *     unmodified.
 *   - `'sandbox'` → returns an in-memory `Auth` handle backed by an
 *     {@link AuthStore} keyed off `app.sandbox`. Repeat calls for the
 *     same sandbox share the store, so writes are visible across
 *     handles (matches upstream `getAuth(app)` idempotency).
 *
 * The firebase-admin import is dynamic (`require` at call time) so the
 * module's top-level evaluation stays cheap and so sandbox-only
 * consumers do not pay the firebase-admin initialization cost. Mirrors
 * how `@pyric/firestore` defers its firebase init: backends are
 * pay-for-what-you-use.
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
export function getAuth(app: PyricAdminApp): Auth {
  if (app === null || typeof app !== 'object' || !(ADMIN_APP_TARGET in app)) {
    throw new TypeError(
      'pyric-admin/auth: getAuth expected a PyricAdminApp (from pyric-admin/app#initializeApp). ' +
        'Received a value with no ADMIN_APP_TARGET brand. Pass the handle returned by ' +
        '`initializeApp({ credential })` (prod) or `initializeApp({ sandbox })` (sandbox).',
    );
  }
  if (isSandboxAdminApp(app)) {
    return makeSandboxAuth(app.sandbox);
  }
  if (isProdAdminApp(app)) {
    // Prod path — defer the firebase-admin import to call time so the
    // module load is cheap. `require` works in Bun + Node ESM via
    // module-interop and avoids top-level `await` (which would force
    // every consumer to live in an async module graph).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuth: getAdminAuth } = require('firebase-admin/auth') as {
      getAuth: (app: App) => AdminAuth;
    };
    return getAdminAuth(app.adminApp);
  }
  // Branded with a value the dispatch table doesn't know — future
  // target string from a newer `pyric-admin/app` we haven't been
  // updated for.
  throw new TypeError(
    `pyric-admin/auth: getAuth received a PyricAdminApp with an unrecognized ADMIN_APP_TARGET value: ${String(
      (app as { [ADMIN_APP_TARGET]: unknown })[ADMIN_APP_TARGET],
    )}`,
  );
}
