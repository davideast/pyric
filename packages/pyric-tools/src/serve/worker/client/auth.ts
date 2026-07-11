/**
 * Worker-client Auth surface — mirrors `pyric/auth` / `firebase/auth` over the
 * port. Per-port sessions (#754): each port owns its own session; the client
 * keeps a local `currentUser` mirror updated from the authState stream while the
 * worker owns the real `User` and token minting.
 */

import type {
  InboundMessage,
  SerializedUser,
  SerializedUserCredential,
  SerializedIdTokenResult,
  AuthPersistenceMode,
  ResolvedIdentity,
} from '../protocol.js';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import { nextId, nextSubId, rpc, wirePort, _snapSubs } from './core.js';
import type { ClientDb, Unsubscribe } from './handles.js';

// ════════════════════════════════════════════════════════════════════════
//  AUTH SURFACE (mirrors `pyric/auth` / `firebase/auth`)
// ════════════════════════════════════════════════════════════════════════
//
// PER-PORT SESSIONS (#754)
// ------------------------
// The worker hosts ONE sandbox (one user pool, one data store, one ruleset)
// but each port (tab / client) owns its OWN session: sign-ins bind to THIS
// port, `onAuthStateChanged` fires for THIS port's transitions only, and
// data ops from this port evaluate rules under its session. Two tabs can be
// two different users on the same live backend — the multi-user testing
// surface a single-identity sandbox can't provide. Session persistence
// across reloads is client-side (SessionStore + `restorePortSession`).
//
// CLIENT-SIDE currentUser MIRROR
// ------------------------------
// The worker holds the one real `User`. The client keeps a local
// `ClientUser` mirror updated from the authState stream, so `auth.currentUser`
// is synchronously readable (matching firebase/auth). Token accessors RPC to
// the worker (the worker owns token minting).

/**
 * Client-side User — a snapshot of the worker's `User` with token accessors
 * that RPC back to the worker. Mirrors `firebase/auth`'s `User` shape.
 */
export interface ClientUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string | null;
  readonly providerData: SerializedUser['providerData'];
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<SerializedIdTokenResult>;
}

/** Client-side UserCredential — mirrors `firebase/auth`. */
export interface ClientUserCredential {
  user: ClientUser;
  providerId: string | null;
  operationType: 'signIn' | 'reauthenticate' | 'link';
}

/**
 * Client-side Auth handle. Holds the port + a local `currentUser` mirror.
 * Returned by `getAuth(db | workerUrl)`. Mirrors `firebase/auth`'s `Auth`.
 */
export interface ClientAuth {
  readonly __kind: 'client-auth';
  readonly port: MessagePort;
  /** Local mirror of the worker's currentUser, updated from the stream. */
  currentUser: ClientUser | null;
}

/** Hidden per-`ClientUser` port handle so the top-level `updateProfile(user, …)`
 *  free function can RPC without an `auth` handle in scope (mirrors
 *  `firebase/auth`'s user-only signature). Non-enumerable — never serialized. */
const CLIENT_USER_PORT: unique symbol = Symbol('pyric.clientUser.port');

/** Build a token-capable ClientUser from a wire SerializedUser. */
function makeClientUser(port: MessagePort, raw: SerializedUser): ClientUser {
  const user: ClientUser = {
    uid: raw.uid,
    email: raw.email,
    emailVerified: raw.emailVerified,
    displayName: raw.displayName,
    photoURL: raw.photoURL,
    phoneNumber: raw.phoneNumber,
    isAnonymous: raw.isAnonymous,
    providerId: raw.providerId,
    providerData: raw.providerData,
    async getIdToken(forceRefresh?: boolean) {
      return (await rpc(port, {
        t: 'op', id: nextId(), method: 'auth.getIdToken', forceRefresh,
      })) as string;
    },
    async getIdTokenResult(forceRefresh?: boolean) {
      return (await rpc(port, {
        t: 'op', id: nextId(), method: 'auth.getIdTokenResult', forceRefresh,
      })) as SerializedIdTokenResult;
    },
  };
  Object.defineProperty(user, CLIENT_USER_PORT, { value: port, enumerable: false });
  return user;
}

/** Convert a wire SerializedUser|null to a ClientUser|null. */
function toClientUser(port: MessagePort, raw: SerializedUser | null): ClientUser | null {
  return raw ? makeClientUser(port, raw) : null;
}

/**
 * Get the worker-backed Auth handle.
 *
 * Mirrors `pyric/auth`'s `getAuth(sandbox)` / `firebase/auth`'s
 * `getAuth(app)` — but the input is either an existing `ClientDb` (reusing
 * its port, the common case in serve where Firestore + auth share one
 * worker) or a worker URL (standalone).
 *
 * The returned handle seeds its `currentUser` mirror by opening an internal
 * authState subscription that keeps it live across tabs.
 */
export function getAuth(source: ClientDb | string | URL, name?: string): ClientAuth {
  let port: MessagePort;
  if (typeof source === 'object' && '__kind' in source && source.__kind === 'client-db') {
    port = source.port;
  } else {
    if (typeof SharedWorker === 'undefined') {
      throw new Error(
        'SharedWorker is not available. ' +
        'Open this page over http:// (not file://) and use a supported browser ' +
        '(Chrome 4+, Firefox 29+, Safari 16.4+).',
      );
    }
    const worker = new SharedWorker(source as string | URL, {
      type: 'classic',
      name: name ?? 'pyric-shared-worker',
    });
    port = worker.port;
    port.start();
    wirePort(port);
  }

  const auth: ClientAuth = { __kind: 'client-auth', port, currentUser: null };

  // Internal authState subscription keeps `auth.currentUser` live. Per-port
  // sessions (#754): only THIS port's sign-ins/outs (and its session restore)
  // fire here — another tab's sign-in is another user, not an update to us.
  const subId = nextSubId();
  _snapSubs.set(subId, {
    next: (raw) => {
      auth.currentUser = toClientUser(port, raw as SerializedUser | null);
    },
  });
  port.postMessage({ t: 'sub', subId, target: 'authState' } satisfies InboundMessage);

  return auth;
}

/**
 * Connect to the auth emulator. No-op shim over the worker: the worker's
 * sandbox IS the emulator-equivalent backend, so there's nothing to point at.
 * Present for surface parity so app code that calls it doesn't break.
 */
export function connectAuthEmulator(
  _auth: ClientAuth,
  _url: string,
  _options?: { disableWarnings?: boolean },
): void {
  // Intentional no-op — the worker's sandbox is the local auth backend.
}

// ─── Sign-in / out / create (RPC) ─────────────────────────────────────────

export async function createUserWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.createUser', email, password,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

// ─── Admin user-DB ops (Pyric Studio data browse) ─────────────────────────
// Mirror `pyric/auth`'s `sandbox.{listUsers,createUser,updateUser,deleteUser,
// clearUsers}` over the port. No lens (admin control surface), so bare `rpc`.

export async function listUsers(auth: ClientAuth): Promise<AuthUserRecord[]> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.listUsers',
  })) as AuthUserRecord[];
}

export async function adminCreateUser(
  auth: ClientAuth,
  request: CreateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminCreateUser',
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminUpdateUser(
  auth: ClientAuth,
  uid: string,
  request: UpdateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminUpdateUser', uid,
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminDeleteUser(auth: ClientAuth, uid: string): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminDeleteUser', uid });
}

export async function adminClearUsers(auth: ClientAuth): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminClearUsers' });
}

// ─── Sign-in provider config (Pyric Studio S-AUTH) ────────────────────────
// Mirror `pyric/auth`'s `sandbox.{getAuthProviderConfig,setAuthProviderConfig}`
// over the port. No dedicated subscription: `setProviderConfig` fires a
// `provider_config_update` sandbox event, so a caller re-reads via
// `getProviderConfig` on the SAME event feed `listUsers` callers already
// subscribe to (see `worker-live.ts`'s `subscribeUsers`).

export async function getProviderConfig(
  auth: ClientAuth,
): Promise<Array<{ providerId: string; enabled: boolean }>> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.getProviderConfig',
  })) as Array<{ providerId: string; enabled: boolean }>;
}

export async function setProviderConfig(
  auth: ClientAuth,
  providerId: string,
  enabled: boolean,
): Promise<void> {
  await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.setProviderConfig', providerId, enabled,
  });
}

export async function signInWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInEmail', email, password,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInAnonymously(auth: ClientAuth): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInAnonymously',
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signOut(auth: ClientAuth): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.signOut' });
  // The authState stream will also clear the mirror; set eagerly so a
  // synchronous read right after `await signOut()` reflects the change.
  auth.currentUser = null;
}

/**
 * Bridge a provider identity resolved IN-PAGE to the worker (the provider
 * sign-in seam). The entry adapter's worker-path `signInWithPopup`/
 * `signInWithRedirect` runs the in-page `AuthFlowResolver` (which can't cross
 * the worker port), then calls this with the picked identity; the worker seeds
 * it + signs it in, returning a worker-backed credential. The mirror updates
 * eagerly (like the email/anon paths) so a synchronous `auth.currentUser`
 * read right after the await reflects the new user.
 */
export async function acceptProviderCredential(
  auth: ClientAuth,
  identity: ResolvedIdentity,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.acceptIdentity', identity,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/**
 * Re-establish THIS PORT's session for an existing identity (#754) — the
 * per-tab reload restore. The page persists its uid in web storage
 * (SessionStore); runtime.ts calls this at boot BEFORE app code runs. Soft:
 * returns null (and leaves the port signed out) when the uid no longer
 * resolves, so a stale record never throws.
 */
export async function restorePortSession(
  auth: ClientAuth,
  uid: string,
): Promise<ClientUser | null> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.restorePortSession', uid,
  })) as SerializedUser | null;
  const user = toClientUser(auth.port, raw);
  if (user) auth.currentUser = user;
  return user;
}

function hydrateCred(auth: ClientAuth, raw: SerializedUserCredential): ClientUserCredential {
  const user = makeClientUser(auth.port, raw.user);
  // Eagerly update the mirror so `auth.currentUser` is correct immediately
  // after the await, before the broadcast stream lands.
  auth.currentUser = user;
  return { user, providerId: raw.providerId, operationType: raw.operationType };
}

// ─── Persistence ──────────────────────────────────────────────────────────

/** Persistence markers — mirror `firebase/auth` / `pyric/auth`. */
export const inMemoryPersistence = { type: 'NONE' } as const;

export const browserSessionPersistence = { type: 'SESSION' } as const;

export const browserLocalPersistence = { type: 'LOCAL' } as const;

export type ClientPersistence = { readonly type: AuthPersistenceMode };

/**
 * Record the session-persistence mode on the worker (surface parity). The
 * effective persistence is CLIENT-side (#754): the entry adapter mirrors the
 * mode into the page's SessionStore, which decides where — or whether — this
 * tab's session uid is stored for reload restore.
 */
export async function setPersistence(
  auth: ClientAuth,
  persistence: ClientPersistence,
): Promise<void> {
  await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.setPersistence', mode: persistence.type,
  });
}

// ─── Observers (streaming subs) ────────────────────────────────────────────

/**
 * Subscribe to auth-state changes. Mirrors `firebase/auth`'s
 * `onAuthStateChanged`. Fires immediately with THIS PORT's current session,
 * then on every change to it (#754: sessions are per-port — another tab's
 * sign-in is a different user, not an update to this one). Updates the
 * handle's `currentUser` mirror before invoking the callback.
 */
export function onAuthStateChanged(
  auth: ClientAuth,
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  return openAuthSub(auth, 'authState', callback);
}

/**
 * Subscribe to ID-token changes. Mirrors `firebase/auth`'s
 * `onIdTokenChanged` — fires on THIS PORT's identity transitions (per-port
 * sessions, #754).
 */
export function onIdTokenChanged(
  auth: ClientAuth,
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  return openAuthSub(auth, 'idToken', callback);
}

function openAuthSub(
  auth: ClientAuth,
  target: 'authState' | 'idToken',
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = auth.port;

  _snapSubs.set(subId, {
    next: (raw) => {
      const user = toClientUser(port, raw as SerializedUser | null);
      auth.currentUser = user;
      callback(user);
    },
  });

  port.postMessage({ t: 'sub', subId, target } satisfies InboundMessage);

  return () => {
    _snapSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

// ─── Token accessors (top-level mirrors) ──────────────────────────────────

/** Top-level mirror of `firebase/auth`'s `getIdToken(user)`. */
export async function getIdToken(user: ClientUser, forceRefresh?: boolean): Promise<string> {
  return user.getIdToken(forceRefresh);
}

/** Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`. */
export async function getIdTokenResult(
  user: ClientUser,
  forceRefresh?: boolean,
): Promise<SerializedIdTokenResult> {
  return user.getIdTokenResult(forceRefresh);
}

/**
 * Top-level mirror of `firebase/auth`'s `updateProfile(user, profile)` over
 * the worker. RPCs `auth.updateProfile` for THIS PORT's session (the worker
 * owns the real `User`), then mutates the passed `user` mirror in place with
 * the returned fields so a synchronous read right after the await is
 * consistent. `null` clears a field; an absent field is left untouched.
 *
 * The port is recovered from the hidden {@link CLIENT_USER_PORT} handle stamped
 * on every `ClientUser`, so this works without an `auth` handle in scope.
 */
export async function updateProfile(
  user: ClientUser,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  const port = (user as { [CLIENT_USER_PORT]?: MessagePort })[CLIENT_USER_PORT];
  if (!port) {
    const err = new Error(
      'updateProfile: unrecognized user — was it produced by a worker-path sign-in?',
    ) as Error & { code: string };
    err.code = 'auth/invalid-user-token';
    throw err;
  }
  const raw = (await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.updateProfile',
    displayName: profile.displayName, photoURL: profile.photoURL,
  })) as SerializedUser;
  // Mutate the passed mirror in place (readonly at the type level, plain data
  // at runtime) so held references reflect the change immediately.
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.displayName = raw.displayName;
  mutable.photoURL = raw.photoURL;
  mutable.providerData = raw.providerData;
}

// ─── Provider flows — NOT supported over the worker yet ───────────────────

/**
 * Provider sign-in (`signInWithCredential`, `signInWithPopup`,
 * `signInWithRedirect`) needs the AuthFlowResolver, which lives in-page and
 * can't cross the worker port. NOT SUPPORTED over the SharedWorker in v1 —
 * a clear error rather than silent breakage. Tracked as a Phase 2 follow-up:
 * thread the resolver through, or run provider flows in-page and hand the
 * resulting credential to the worker.
 */
export function signInWithCredential(): Promise<never> {
  return Promise.reject(makeUnsupported('signInWithCredential'));
}

/**
 * `beforeAuthStateChanged` gates a LOCAL identity transition — the
 * worker owns the shared user pool + fires the real transition on its
 * own side of the port, so a page-local gate registered here would
 * either never run (silently useless) or run too late to actually
 * block anything. Rather than accept a callback that quietly does
 * nothing, fail loudly at registration time — same defensive pattern
 * as {@link signInWithCredential}. Follow-up: thread registration
 * through the worker RPC protocol so the gate can run host-side before
 * the worker commits a transition.
 */
export function beforeAuthStateChanged(): never {
  throw makeUnsupported('beforeAuthStateChanged');
}

function makeUnsupported(api: string): Error & { code: string } {
  const err = new Error(
    `${api} is not supported over the SharedWorker yet (provider flows need ` +
    'the in-page AuthFlowResolver). Follow-up: thread the resolver through or ' +
    'run the flow in-page and hand the credential to the worker.',
  ) as Error & { code: string };
  err.code = 'auth/operation-not-supported-in-this-environment';
  return err;
}
