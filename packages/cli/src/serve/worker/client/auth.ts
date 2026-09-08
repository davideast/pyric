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
import { closeSubscription, isDisconnectedPort, nextId, nextSubId, openSnapshotSubscription, rpc, wirePort } from './core.js';
import type { ClientDb, ClientPort, Unsubscribe } from './handles.js';

export {
  listUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
  adminClearUsers,
  getProviderConfig,
  setProviderConfig,
} from './auth-admin.js';

// ════════════════════════════════════════════════════════════════════════
//  AUTH SURFACE (mirrors `pyric/auth` / `firebase/auth`)
// ════════════════════════════════════════════════════════════════════════

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
  /** Tenant this user authenticated under, or `null` for the project-level
   *  pool. Mirrors `firebase/auth`'s `User.tenantId`. */
  readonly tenantId: string | null;
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
  readonly port: ClientPort;
  /** Local mirror of the worker's currentUser, updated from the stream. */
  currentUser: ClientUser | null;
  /** Identity Platform tenant that subsequent sign-ins on THIS PORT
   *  authenticate against, or `null` for the project-level pool. Assign
   *  before calling a sign-in function: the value crosses the port with the
   *  sign-in request, so the worker's session state carries it and rules
   *  evaluate the port's operations with
   *  `request.auth.token.firebase.tenant` set to it. */
  tenantId: string | null;
}

/** Hidden per-`ClientUser` port handle so top-level user lifecycle functions
 *  can RPC without an `auth` handle in scope (mirrors `firebase/auth`'s
 *  user-only signature). Non-enumerable — never serialized. */
const CLIENT_USER_PORT: unique symbol = Symbol('pyric.clientUser.port');

/** Build a token-capable ClientUser from a wire SerializedUser. */
function makeClientUser(port: ClientPort, raw: SerializedUser): ClientUser {
  const user: ClientUser = {
    uid: raw.uid,
    email: raw.email,
    emailVerified: raw.emailVerified,
    displayName: raw.displayName,
    photoURL: raw.photoURL,
    phoneNumber: raw.phoneNumber,
    isAnonymous: raw.isAnonymous,
    tenantId: raw.tenantId,
    providerId: raw.providerId,
    tenantId: raw.tenantId ?? null,
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
function toClientUser(port: ClientPort, raw: SerializedUser | null): ClientUser | null {
  return raw ? makeClientUser(port, raw) : null;
}

/**
 * Get the worker-backed Auth handle.
 */
export function getAuth(source: ClientDb | string | URL, name?: string): ClientAuth {
  let port: ClientPort;
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

<<<<<<< HEAD
  let _tenantId: string | null = null;
  const auth: ClientAuth = {
    __kind: 'client-auth',
    port,
    currentUser: null,
    get tenantId() {
      return _tenantId;
    },
    set tenantId(val: string | null) {
      _tenantId = val;
      void rpc(port, { t: 'op', id: nextId(), method: 'auth.setTenantId', tenantId: val });
    },
  };
=======
  const auth: ClientAuth = { __kind: 'client-auth', port, currentUser: null, tenantId: null };
>>>>>>> origin/main

  // Internal authState subscription keeps `auth.currentUser` live.
  const subId = nextSubId();
  openSnapshotSubscription(port, subId, {
    port,
    next: (raw) => {
      auth.currentUser = toClientUser(port, raw as SerializedUser | null);
    },
  }, { t: 'sub', subId, target: 'authState' } satisfies InboundMessage);

  return auth;
}

/**
 * Connect to the auth emulator. No-op shim over the worker.
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
<<<<<<< HEAD
    t: 'op',
    id: nextId(),
    method: 'auth.createUser',
    email,
    password,
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
=======
    t: 'op', id: nextId(), method: 'auth.createUser', email, password,
    tenantId: auth.tenantId,
>>>>>>> origin/main
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
<<<<<<< HEAD
    t: 'op',
    id: nextId(),
    method: 'auth.signInEmail',
    email,
    password,
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
=======
    t: 'op', id: nextId(), method: 'auth.signInEmail', email, password,
    tenantId: auth.tenantId,
>>>>>>> origin/main
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInAnonymously(auth: ClientAuth): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
<<<<<<< HEAD
    t: 'op',
    id: nextId(),
    method: 'auth.signInAnonymously',
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
=======
    t: 'op', id: nextId(), method: 'auth.signInAnonymously', tenantId: auth.tenantId,
>>>>>>> origin/main
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signOut(auth: ClientAuth): Promise<void> {
  if (isDisconnectedPort(auth.port)) {
    auth.currentUser = null;
    return;
  }
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.signOut' });
  auth.currentUser = null;
}

/**
 * Bridge a provider identity resolved IN-PAGE to the worker.
 */
export async function acceptProviderCredential(
  auth: ClientAuth,
  identity: ResolvedIdentity,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
<<<<<<< HEAD
    t: 'op',
    id: nextId(),
    method: 'auth.acceptIdentity',
    identity,
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
=======
    t: 'op', id: nextId(), method: 'auth.acceptIdentity', identity,
    tenantId: auth.tenantId,
>>>>>>> origin/main
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/**
 * Re-establish THIS PORT's session for an existing identity (#754).
 */
export async function restorePortSession(
  auth: ClientAuth,
  uid: string,
): Promise<ClientUser | null> {
  const raw = (await rpc(auth.port, {
<<<<<<< HEAD
    t: 'op',
    id: nextId(),
    method: 'auth.restorePortSession',
    uid,
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
=======
    t: 'op', id: nextId(), method: 'auth.restorePortSession', uid,
    tenantId: auth.tenantId,
>>>>>>> origin/main
  })) as SerializedUser | null;
  const user = toClientUser(auth.port, raw);
  auth.currentUser = user;
  return user;
}

function hydrateCred(auth: ClientAuth, raw: SerializedUserCredential): ClientUserCredential {
  const user = makeClientUser(auth.port, raw.user);
  auth.currentUser = user;
  return { user, providerId: raw.providerId, operationType: raw.operationType };
}

// ─── Persistence ──────────────────────────────────────────────────────────

export const inMemoryPersistence = { type: 'NONE' } as const;
export const browserSessionPersistence = { type: 'SESSION' } as const;
export const browserLocalPersistence = { type: 'LOCAL' } as const;

export type ClientPersistence = { readonly type: AuthPersistenceMode };

export async function setPersistence(
  auth: ClientAuth,
  persistence: ClientPersistence,
): Promise<void> {
  await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.setPersistence', mode: persistence.type,
  });
}

// ─── Observers (streaming subs) ────────────────────────────────────────────

export function onAuthStateChanged(
  auth: ClientAuth,
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  return openAuthSub(auth, 'authState', callback);
}

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

  openSnapshotSubscription(port, subId, {
    port,
    next: (raw) => {
      const user = toClientUser(port, raw as SerializedUser | null);
      auth.currentUser = user;
      callback(user);
    },
  }, { t: 'sub', subId, target } satisfies InboundMessage);

  return () => {
    closeSubscription(port, subId);
  };
}

// ─── Token accessors (top-level mirrors) ──────────────────────────────────

export async function getIdToken(user: ClientUser, forceRefresh?: boolean): Promise<string> {
  return user.getIdToken(forceRefresh);
}

export async function getIdTokenResult(
  user: ClientUser,
  forceRefresh?: boolean,
): Promise<SerializedIdTokenResult> {
  return user.getIdTokenResult(forceRefresh);
}

function requireUserPort(user: ClientUser, api: string): ClientPort {
  const port = (user as { [CLIENT_USER_PORT]?: ClientPort })[CLIENT_USER_PORT];
  if (!port) {
    const err = new Error(
      `${api}: unrecognized user — was it produced by a worker-path sign-in?`,
    ) as Error & { code: string };
    err.code = 'auth/invalid-user-token';
    throw err;
  }
  return port;
}

export async function updateProfile(
  user: ClientUser,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  const port = requireUserPort(user, 'updateProfile');
  const raw = (await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.updateProfile',
    displayName: profile.displayName, photoURL: profile.photoURL,
  })) as SerializedUser;
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.displayName = raw.displayName;
  mutable.photoURL = raw.photoURL;
  mutable.providerData = raw.providerData;
}

export async function reload(user: ClientUser): Promise<void> {
  const port = requireUserPort(user, 'reload');
  const raw = (await rpc(port, { t: 'op', id: nextId(), method: 'auth.reload' })) as SerializedUser;
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.email = raw.email;
  mutable.emailVerified = raw.emailVerified;
  mutable.displayName = raw.displayName;
  mutable.photoURL = raw.photoURL;
  mutable.phoneNumber = raw.phoneNumber;
  mutable.providerData = raw.providerData;
  mutable.tenantId = raw.tenantId ?? null;
}

export async function deleteUser(user: ClientUser): Promise<void> {
  const port = requireUserPort(user, 'deleteUser');
  await rpc(port, { t: 'op', id: nextId(), method: 'auth.deleteUser' });
}

export async function updateEmail(user: ClientUser, newEmail: string): Promise<void> {
  const port = requireUserPort(user, 'updateEmail');
  const raw = (await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.updateEmail', email: newEmail,
  })) as SerializedUser;
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.email = raw.email;
  mutable.providerData = raw.providerData;
}

export async function updatePassword(user: ClientUser, newPassword: string): Promise<void> {
  const port = requireUserPort(user, 'updatePassword');
  await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.updatePassword', password: newPassword,
  });
}

export async function updateCurrentUser(
  auth: ClientAuth,
  user: ClientUser | null,
): Promise<void> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.updateCurrentUser', uid: user?.uid ?? null,
  })) as SerializedUser | null;
  auth.currentUser = toClientUser(auth.port, raw);
}

/**
 * OAuth Credential Sign-In (`auth.signInWithCredential`) over the SharedWorker.
 */
export async function signInWithCredential(
  auth: ClientAuth,
  credential: {
    providerId: string;
    idToken?: string | null;
    accessToken?: string | null;
    rawNonce?: string | null;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    uid?: string | null;
  },
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op',
    id: nextId(),
    method: 'auth.signInWithCredential',
    credential: {
      providerId: credential.providerId,
      idToken: credential.idToken ?? null,
      accessToken: credential.accessToken ?? null,
      rawNonce: credential.rawNonce ?? null,
      email: credential.email ?? null,
      displayName: credential.displayName ?? null,
      photoURL: credential.photoURL ?? null,
      uid: credential.uid ?? null,
    },
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export function beforeAuthStateChanged(): never {
  const err = new Error(
    'beforeAuthStateChanged is not supported over the SharedWorker yet.',
  ) as Error & { code: string };
  err.code = 'auth/operation-not-supported-in-this-environment';
  throw err;
}
