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
  OpMessage,
} from '../protocol.js';
import { absolutePhotoUrl, realmOrigin } from 'pyric/sandbox/internal';
import {
  credentialWire,
  normalizeClientIdTokenResult,
  normalizeWorkerProfileUpdate,
  type SignInCredential,
} from './auth-credential-wire.js';
import { closeSubscription, isDisconnectedPort, nextId, nextSubId, openSnapshotSubscription, rpc, wirePort } from './core.js';
import type { ClientDb, ClientPort, Unsubscribe } from './handles.js';
import {
  applyClientUserSessionKey,
  applySerializedUserFields,
  attachHeldUserIdentity,
  clientUserSessionKey,
  reconcileMatchingCurrentUsers,
  registerPortAuthHandle,
  requireUserPort,
  resolveClientProviderData,
  stampClientUserMetadata,
  syncClientUserFromWire,
} from './auth-user-identity.js';
export { stageSignInResult } from './auth-staged.js';
export { clientUserSessionKey, requireUserPort } from './auth-user-identity.js';

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
  _additionalUserInfo?: {
    readonly isNewUser: boolean;
    readonly profile: Record<string, unknown>;
    readonly providerId: string | null;
  };
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
  authStateReady(): Promise<void>;
  signOut(): Promise<void>;
}

/** Build a token-capable ClientUser from a wire SerializedUser. */
function makeClientUser(port: ClientPort, raw: SerializedUser): ClientUser {
  const user: ClientUser = {
    uid: raw.uid,
    email: raw.email,
    emailVerified: raw.emailVerified,
    displayName: raw.displayName,
    photoURL: absolutePhotoUrl(raw.photoURL, realmOrigin()),
    phoneNumber: raw.phoneNumber,
    isAnonymous: raw.isAnonymous,
    tenantId: raw.tenantId ?? null,
    providerId: raw.providerId,
    providerData: resolveClientProviderData(raw.providerData),
    async getIdToken(forceRefresh?: boolean) {
      return (await rpc(port, attachHeldUserIdentity(user, {
        t: 'op', id: nextId(), method: 'auth.getIdToken', forceRefresh,
      }))) as string;
    },
    async getIdTokenResult(forceRefresh?: boolean) {
      return normalizeClientIdTokenResult((await rpc(port, attachHeldUserIdentity(user, {
        t: 'op', id: nextId(), method: 'auth.getIdTokenResult', forceRefresh,
      }))) as SerializedIdTokenResult);
    },
  };
  stampClientUserMetadata(user, port, raw.sessionKey);
  return user;
}

/**
 * Reconcile a wire `SerializedUser | null` against `auth.currentUser` so
 * same-UID snapshots, multi-listener deliveries, and forced token refreshes
 * preserve object reference identity (`===`), matching `@firebase/auth` and
 * in-process `SandboxAuthBackend`.
 */
function reconcileClientUser(auth: ClientAuth, raw: SerializedUser | null): ClientUser | null {
  if (raw === null) {
    auth.currentUser = null;
    return null;
  }
  const existing = auth.currentUser;
  const targetTenant = raw.tenantId ?? null;
  if (existing !== null && existing.uid === raw.uid && existing.tenantId === targetTenant) {
    return applySerializedUserFields(existing, raw);
  }
  const created = makeClientUser(auth.port, raw);
  auth.currentUser = created;
  return created;
}

/**
 * Get the worker-backed Auth handle.
 */
export function getAuth(source: ClientDb | string | URL, name?: string): ClientAuth {
  let port: ClientPort;
  const isWorkerSource = typeof source === 'string' || source instanceof URL;
  if (isWorkerSource) {
    const isSharedWorkerUnavailable = typeof SharedWorker === 'undefined';
    if (isSharedWorkerUnavailable) {
      throw new Error(
        'SharedWorker is not available. ' +
        'Open this page over http:// (not file://) and use a supported browser ' +
        '(Chrome 4+, Firefox 29+, Safari 16.4+).',
      );
    }
    const worker = new SharedWorker(source, {
      type: 'classic',
      name: name ?? 'pyric-shared-worker',
    });
    port = worker.port;
    port.start();
    wirePort(port);
  } else {
    port = source.port;
  }

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
    authStateReady() {
      return waitForClientAuthStateReady(auth);
    },
    signOut() {
      return signOut(auth);
    },
  };

  port.restoreAuth = async (request) => {
    await request({ t: 'op', id: nextId(), method: 'auth.setTenantId', tenantId: auth.tenantId });
    const user = auth.currentUser;
    const isSignedIn = user !== null;
    if (isSignedIn) await restorePortSession(auth, user.uid, request, user.tenantId, clientUserSessionKey(user));
  };

  // ID-token updates also refresh same-UID changes such as provider linking.
  const subId = nextSubId();
  openSnapshotSubscription(port, subId, {
    port,
    next: (raw) => {
      reconcileClientUser(auth, raw as SerializedUser | null);
    },
  }, { t: 'sub', subId, target: 'idToken' } satisfies InboundMessage);

  registerPortAuthHandle(port, auth);

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
    t: 'op', id: nextId(), method: 'auth.createUser', email, password,
    tenantId: auth.tenantId,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInEmail', email, password,
    tenantId: auth.tenantId,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInAnonymously(auth: ClientAuth): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInAnonymously', tenantId: auth.tenantId,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/** @public */
export async function signInWithCustomToken(auth: ClientAuth, customToken: string): Promise<ClientUserCredential> {
  const raw = await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.signInWithCustomToken',
    customToken, tenantId: auth.tenantId }) as SerializedUserCredential;
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
    t: 'op', id: nextId(), method: 'auth.acceptIdentity', identity,
    tenantId: auth.tenantId,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/**
 * Re-establish THIS PORT's session for an existing identity (#754).
 */
export async function restorePortSession(
  auth: ClientAuth,
  uid: string,
  request: (message: OpMessage) => Promise<unknown> = message => rpc(auth.port, message),
  tenantId: string | null = auth.tenantId,
  sessionKey?: string,
): Promise<ClientUser | null> {
  const raw = (await request({
    t: 'op', id: nextId(), method: 'auth.restorePortSession', uid,
    tenantId, ...(sessionKey === undefined ? {} : { sessionKey }),
  })) as SerializedUser | null;
  return reconcileClientUser(auth, raw);
}

export function hydrateCred(auth: ClientAuth, raw: SerializedUserCredential): ClientUserCredential {
  const user = reconcileClientUser(auth, raw.user)!;
  return {
    user,
    providerId: raw.providerId,
    operationType: raw.operationType,
    _additionalUserInfo: raw.additionalUserInfo,
  };
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

export type ClientAuthObserver =
  | ((user: ClientUser | null) => void)
  | {
      next?: (user: ClientUser | null) => void;
      error?: (err: Error) => void;
      complete?: () => void;
    };

function waitForClientAuthStateReady(auth: ClientAuth): Promise<void> {
  if (auth.currentUser !== null || isDisconnectedPort(auth.port)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: Unsubscribe | undefined;
    unsubscribe = onAuthStateChanged(auth, {
      next: () => {
        settled = true;
        unsubscribe?.();
        resolve();
      },
      error: (err) => {
        settled = true;
        unsubscribe?.();
        reject(err);
      },
    });
    if (settled) {
      unsubscribe();
    }
  });
}

export function onAuthStateChanged(
  auth: ClientAuth,
  callback: ClientAuthObserver,
): Unsubscribe {
  return openAuthSub(auth, 'authState', callback);
}

export function onIdTokenChanged(
  auth: ClientAuth,
  callback: ClientAuthObserver,
): Unsubscribe {
  return openAuthSub(auth, 'idToken', callback);
}

function openAuthSub(
  auth: ClientAuth,
  target: 'authState' | 'idToken',
  callback: ClientAuthObserver,
): Unsubscribe {
  const subId = nextSubId();
  const port = auth.port;

  openSnapshotSubscription(port, subId, {
    port,
    next: (raw) => {
      const user = reconcileClientUser(auth, raw as SerializedUser | null);
      try {
        if (typeof callback === 'function') {
          callback(user);
        } else if (typeof callback?.next === 'function') {
          callback.next(user);
        }
      } catch {
        // Observational: swallow so a faulty subscriber cannot destabilize the auth stream.
      }
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

export async function updateProfile(
  user: ClientUser,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  const port = requireUserPort(user, 'updateProfile');
  const normalized = normalizeWorkerProfileUpdate(profile);
  if (normalized.displayName === undefined && normalized.photoURL === undefined) {
    return;
  }
  const raw = (await rpc(port, attachHeldUserIdentity(user, {
    t: 'op',
    id: nextId(),
    method: 'auth.updateProfile',
    displayName: normalized.displayName,
    photoURL: normalized.photoURL,
  }))) as SerializedUser;
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.displayName = raw.displayName;
  mutable.photoURL = absolutePhotoUrl(raw.photoURL, realmOrigin());
  mutable.providerData = resolveClientProviderData(raw.providerData);
  applyClientUserSessionKey(user, raw.sessionKey);
  reconcileMatchingCurrentUsers(port, raw);
}

export async function reload(user: ClientUser): Promise<void> {
  const port = requireUserPort(user, 'reload');
  const raw = (await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.reload',
  }))) as SerializedUser;
  syncClientUserFromWire(port, user, raw);
}

export async function deleteUser(user: ClientUser): Promise<void> {
  const port = requireUserPort(user, 'deleteUser');
  await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.deleteUser',
  }));
}

export async function updateEmail(user: ClientUser, newEmail: string): Promise<void> {
  const port = requireUserPort(user, 'updateEmail');
  const raw = (await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.updateEmail', email: newEmail,
  }))) as SerializedUser;
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.email = raw.email;
  mutable.emailVerified = raw.emailVerified;
  mutable.providerData = resolveClientProviderData(raw.providerData);
  applyClientUserSessionKey(user, raw.sessionKey);
  reconcileMatchingCurrentUsers(port, raw);
}

export async function updatePassword(user: ClientUser, newPassword: string): Promise<void> {
  const port = requireUserPort(user, 'updatePassword');
  const raw = (await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.updatePassword', password: newPassword,
  }))) as SerializedUser | null | undefined;
  if (raw !== null && raw !== undefined) {
    applyClientUserSessionKey(user, raw.sessionKey);
    reconcileMatchingCurrentUsers(port, raw);
  }
}

export async function updateCurrentUser(auth: ClientAuth, user: ClientUser | null): Promise<void> {
  const clearedSameHandle = user !== null && auth.currentUser === user;
  if (clearedSameHandle) auth.currentUser = null;
  const opMessage: OpMessage = {
    t: 'op', id: nextId(), method: 'auth.updateCurrentUser', uid: user?.uid ?? null,
    tenantId: auth.tenantId ?? user?.tenantId ?? null,
  };
  if (user !== null) {
    const key = clientUserSessionKey(user);
    if (key !== undefined) opMessage.sessionKey = key;
  }
  try {
    const raw = (await rpc(auth.port, opMessage)) as SerializedUser | null;
    reconcileClientUser(auth, raw);
  } catch (err) {
    if (clearedSameHandle && auth.currentUser === null) auth.currentUser = user;
    throw err;
  }
}

export async function signInWithCredential(
  auth: ClientAuth,
  credential: SignInCredential,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op',
    id: nextId(),
    method: 'auth.signInWithCredential',
    credential: credentialWire(credential),
    tenantId: auth.tenantId,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/** @public */
export function beforeAuthStateChanged(): never {
  const err = new Error(
    'beforeAuthStateChanged is not supported over the SharedWorker yet.',
  ) as Error & { code: string };
  err.code = 'auth/operation-not-supported-in-this-environment';
  throw err;
}
