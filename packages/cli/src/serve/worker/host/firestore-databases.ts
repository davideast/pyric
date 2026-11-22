/**
 * Per-database Firestore handle and rules state cache on `HostCtx`
 * (ADR-0021 Decision 4, parallel to `host/rtdb-instances.ts`).
 */
import { FirebaseError } from 'pyric/app';
import {
  doc as pyricDoc,
  getAdminFirestore as pyricGetAdminFirestore,
  getFirestore as pyricGetFirestore,
  type Firestore,
} from 'pyric/firestore';
import {
  DEFAULT_FIRESTORE_DATABASE,
  isFirestoreDatabaseDeclared,
  logMissingFirestoreDatabaseNoticeOnce,
  missingFirestoreDatabaseNotFoundMessage,
  normalizeFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import { SandboxError, type AuthLens } from 'pyric/sandbox';
import { portSession } from '../host-auth.js';
import {
  fail,
  hostProjectId,
  post,
  type HostCtx,
  type HostFirestoreDatabase,
  type PortLike,
} from '../host-context.js';
import {
  serializeError,
  type FirestoreSubMessage,
  type OpMessage,
} from '../protocol.js';
import {
  authStateForLens,
  lensCacheKey,
  lensDb,
  resolveTarget,
  sessionCacheKey,
} from './core.js';

export function firestoreDatabaseEntry(
  ctx: HostCtx,
  databaseId: string,
): HostFirestoreDatabase {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  const map = (ctx.firestoreDatabases ??= new Map<string, HostFirestoreDatabase>());
  const existing = map.get(normalized);
  if (existing !== undefined) return existing;
  const created: HostFirestoreDatabase = {
    id: normalized,
    live: pyricGetFirestore(ctx.sandbox, normalized),
  };
  map.set(normalized, created);
  return created;
}

function namedSessionDb(
  ctx: HostCtx,
  port: PortLike,
  entry: HostFirestoreDatabase,
): Firestore {
  const session = portSession(ctx, port);
  if (!session) return entry.live;
  const cache = (ctx.sessionDbs ??= new Map());
  const key = `db:${entry.id}:${sessionCacheKey(session)}`;
  let handle = cache.get(key);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth(session.state), entry.id);
    cache.set(key, handle);
  }
  return handle;
}

/** Resolve the Firestore handle for `(actAs, port, databaseId)` when `databaseId` is named. */
export function lensNamedFirestoreDb(
  ctx: HostCtx,
  databaseId: string,
  actAs?: AuthLens,
  port?: PortLike,
): Firestore {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return ctx.db;
  }
  const entry = firestoreDatabaseEntry(ctx, normalized);
  if (!actAs || actAs.mode === 'app-session') {
    if (port !== undefined) {
      return namedSessionDb(ctx, port, entry);
    }
    return entry.live;
  }
  if (actAs.mode === 'admin') {
    entry.admin ??= pyricGetAdminFirestore(ctx.sandbox, normalized);
    return entry.admin;
  }
  if (actAs.mode === 'anon') {
    entry.anon ??= pyricGetFirestore(ctx.sandbox.withAuth(null), normalized);
    return entry.anon;
  }
  const handles = (ctx.lensHandles ??= new Map());
  const key = `db:${normalized}:${lensCacheKey(actAs)}`;
  let handle = handles.get(key);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth(authStateForLens(actAs)), normalized);
    handles.set(key, handle);
  }
  return handle;
}

export function isUndeclaredRequestedDatabase(ctx: HostCtx, databaseId?: string): databaseId is string {
  if (databaseId === undefined) return false;
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) return false;
  return !isFirestoreDatabaseDeclared(ctx.sandbox, normalized);
}

/**
 * Answer an op targeting an undeclared Firestore database without allocating
 * any `HostFirestoreDatabase` or `LocalEnvironment` entry (ADR-0021 Decisions 3 & 4).
 */
export function handleUndeclaredFirestoreDatabaseOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
  databaseId: string,
  isReadOp: boolean,
): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  try {
    lensDb(ctx, msg.actAs, port);
    const isAdminOrKeyspace =
      msg.actAs?.mode === 'admin' ||
      msg.method === 'listRootCollections' ||
      msg.method === 'listSubcollections';
    if (isAdminOrKeyspace) {
      fail(
        port,
        msg.id,
        new SandboxError(
          'not-found',
          missingFirestoreDatabaseNotFoundMessage(normalized, hostProjectId(ctx) ?? 'demo-project'),
        ),
      );
      return;
    }
    if (msg.method === 'getDocs' || msg.method === 'count' || msg.method === 'aggregate') {
      resolveTarget(ctx.db, msg.source);
    } else if ('path' in msg && typeof msg.path === 'string') {
      pyricDoc(ctx.db, msg.path);
    }
  } catch (e) {
    fail(port, msg.id, e);
    return;
  }
  let requestedPath: string | undefined;
  if ('path' in msg && typeof msg.path === 'string') {
    requestedPath = msg.path;
  }
  logMissingFirestoreDatabaseNoticeOnce(ctx.sandbox, normalized, requestedPath);
  if (isReadOp || msg.method === 'txnCommit') {
    fail(
      port,
      msg.id,
      new FirebaseError('unavailable', 'Failed to get document because the client is offline.'),
    );
    return;
  }
  // Client writes (`setDoc`, `updateDoc`, `deleteDoc`, `addDoc`, `batchCommit`)
  // stay pending on the wire until `terminate()` or port disconnect (ADR-0021 C3).
}

/**
 * Answer a `sub` frame targeting an undeclared Firestore database with C3
 * cached-empty initial delivery (or Admin `not-found`) without host allocation.
 */
export function handleUndeclaredFirestoreDatabaseSub(
  ctx: HostCtx,
  port: PortLike,
  msg: FirestoreSubMessage,
  databaseId: string,
): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  try {
    lensDb(ctx, msg.actAs, port);
    resolveTarget(ctx.db, msg.target);
  } catch (e) {
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(e) } });
    return;
  }
  if (msg.actAs?.mode === 'admin') {
    const err = new SandboxError(
      'not-found',
      missingFirestoreDatabaseNotFoundMessage(normalized, hostProjectId(ctx) ?? 'demo-project'),
    );
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(err) } });
    return;
  }
  let requestedPath: string | undefined;
  if (msg.target.__ref === 'doc') {
    requestedPath = msg.target.path;
  }
  logMissingFirestoreDatabaseNoticeOnce(ctx.sandbox, normalized, requestedPath);
  if (msg.target.__ref === 'doc') {
    const segments = msg.target.path.split('/').filter(Boolean);
    const docId = segments[segments.length - 1] ?? '';
    post(port, {
      t: 'snap',
      subId: msg.subId,
      value: {
        id: docId,
        path: msg.target.path,
        exists: false,
        hasPendingWrites: false,
        fromCache: true,
      },
    });
    return;
  }
  post(port, {
    t: 'snap',
    subId: msg.subId,
    value: {
      docs: [],
      hasPendingWrites: false,
      fromCache: true,
    },
  });
}
