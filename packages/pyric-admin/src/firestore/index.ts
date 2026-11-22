/**
 * `pyric-admin/firestore` -- Admin-shape Firestore.
 *
 * The implementation lives at `pyric/sandbox/admin-firestore` (the
 * pyric-internal admin-compat layer). This subpath is the consumer-
 * facing entry that exposes it under the `pyric-admin` namespace,
 * mirroring `firebase-admin/firestore`.
 *
 * Everything from the internal module is re-exported unchanged EXCEPT
 * `getFirestore`, which is wrapped here to also accept:
 *   - a {@link PyricAdminApp} handle, and
 *   - no argument at all (resolves the default app from `pyric-admin/app`).
 * Both paths mirror `firebase-admin/firestore`'s `getFirestore(app?)`
 * default-app resolution and throw the captured `app/no-app` error when
 * nothing is initialized. The original `getFirestore(ctx)` context form
 * (the load-bearing shape the existing suite uses) is preserved verbatim.
 *
 * RULES-BYPASS PARITY (#394): the two APP-resolution forms -- `getFirestore(app)`
 * and no-arg `getFirestore()` -- mirror `firebase-admin/firestore`'s
 * `getFirestore(app?)`, and REAL firebase-admin bypasses security rules. So both
 * app forms resolve to the rules-BYPASS admin lens (`getAdminFirestore` ->
 * `{ mode: 'admin' }`), exactly as `pyric-admin/database`'s `getDatabase(app)`
 * and `pyric-admin/storage`'s `getStorage(app)` already do. Previously the app
 * forms routed through the anon-lens `getFirestore(sandbox.withAuth(null))`,
 * which evaluates `request.auth == null` and is DENIED by any real ruleset -- a
 * deny-direction divergence from production that blocked the RTDB-trigger ->
 * Firestore-stamp pattern (a Cloud Function's admin write).
 *
 * The `getFirestore(ctx)` CONTEXT form is UNCHANGED and stays rules-ENFORCED
 * (its captured identity is load-bearing for the rules-simulation suite). No
 * page ever reaches this module: a page's `firebase/firestore` resolves to
 * `pyric/firestore` (the rules-enforced client), not `pyric-admin`; only the
 * `firebase-admin/*` -> `pyric-admin/*` swap in the trusted functions child
 * imports this. See {@link getFirestore}.
 */
export * from 'pyric/sandbox/admin-firestore';

import {
  getFirestore as baseGetFirestore,
  getAdminFirestore as baseGetAdminFirestore,
  type SandboxFirestore,
} from 'pyric/sandbox/admin-firestore';
import {
  isRemoteSandbox,
  SandboxContextImpl,
  SandboxError,
  type Sandbox,
  type SandboxContext,
} from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  isSandboxAdminApp,
  type PyricAdminApp,
} from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { adminOnSnapshot, wrapAdminFirestoreHandle } from './admin-value-adapter.js';
import { FieldValue } from './admin-field-value.js';
import { AggregateField, Filter } from './admin-filter-aggregate-cursors.js';
import { GeoPoint } from './admin-geopoint.js';
import { GrpcStatus, setLogFunction } from './admin-grpc-log.js';
import { createAdminGrpcError } from './admin-grpc-errors.js';
import {
  adminRawDbDatabaseId,
  adminRawDbProjectId,
  adminRawDbSandbox,
  adminRootDbDatabaseId,
  adminRootDbProjectId,
  DEFAULT_ADMIN_DATABASE_ID,
} from './admin-handle-registry.js';
import {
  createDatabaseScopedContext,
  createDatabaseScopedSandbox,
  isCalledFromLegacyRootAdminNamespace,
  recordAdminRootOriginalSandbox,
  resolveOptionalAdminDatabaseId,
} from './admin-named-databases.js';
import {
  applyAdminFirestoreSettings,
  type AdminFirestoreSettings,
} from './admin-settings-lifecycle.js';
import { FirebaseFirestoreError } from './admin-vector-and-errors.js';
import {
  registerBypassExistenceReader,
  WriteResult,
} from './admin-write-result-preconditions.js';

export {
  AggregateField,
  FieldValue,
  Filter,
  FirebaseFirestoreError,
  GeoPoint,
  GrpcStatus,
  setLogFunction,
  WriteResult,
};
export type { AdminFirestoreSettings as Settings };

function wrapRootHandle(
  db: SandboxFirestore,
  sandbox: Sandbox | undefined,
  appBacked = false,
  projectId?: string,
  databaseId = DEFAULT_ADMIN_DATABASE_ID,
  originalSandbox?: Sandbox,
): SandboxFirestore {
  if (sandbox !== undefined) {
    adminRawDbSandbox.set(db, sandbox);
  }
  if (projectId !== undefined && projectId.length > 0) {
    adminRawDbProjectId.set(db, projectId);
  }
  adminRawDbDatabaseId.set(db, databaseId);
  const rootOriginal = originalSandbox !== undefined ? originalSandbox : sandbox;
  recordAdminRootOriginalSandbox(db, rootOriginal);
  const wrapped = wrapAdminFirestoreHandle(db, appBacked);
  if (projectId !== undefined && projectId.length > 0) {
    adminRootDbProjectId.set(wrapped, projectId);
  }
  adminRootDbDatabaseId.set(wrapped, databaseId);
  recordAdminRootOriginalSandbox(wrapped, rootOriginal);
  return wrapped;
}

const appFirestoreCache = new WeakMap<PyricAdminApp, Map<string, SandboxFirestore>>();
const appFirestoreInitPreferRest = new WeakMap<PyricAdminApp, Map<string, boolean | undefined>>();
const ctxNamedFirestoreCache = new WeakMap<SandboxContext, Map<string, SandboxFirestore>>();

function getOrCreateAppDbMap(app: PyricAdminApp): Map<string, SandboxFirestore> {
  let byDb = appFirestoreCache.get(app);
  if (byDb === undefined) {
    byDb = new Map<string, SandboxFirestore>();
    appFirestoreCache.set(app, byDb);
  }
  return byDb;
}

function getOrCreateAppSettingsMap(app: PyricAdminApp): Map<string, boolean | undefined> {
  let byDb = appFirestoreInitPreferRest.get(app);
  if (byDb === undefined) {
    byDb = new Map<string, boolean | undefined>();
    appFirestoreInitPreferRest.set(app, byDb);
  }
  return byDb;
}

function buildAppFirestoreInstance(
  app: PyricAdminApp,
  normalizedDbId: string,
): SandboxFirestore {
  const ctx = adminAppToContext(app);
  let projectId = 'pyric-sandbox';
  if (typeof app.options?.projectId === 'string' && app.options.projectId.length > 0) {
    projectId = app.options.projectId;
  }
  const scopedCtx = createDatabaseScopedContext(ctx, normalizedDbId, projectId);
  const rawDb = baseGetAdminFirestore(scopedCtx);
  return wrapRootHandle(
    rawDb,
    scopedCtx.sandbox,
    true,
    projectId,
    normalizedDbId,
    ctx.sandbox,
  );
}

function getAppFirestore(app: PyricAdminApp, databaseId?: unknown): SandboxFirestore {
  assertAdminAppActive(app);
  const normalizedDbId = resolveOptionalAdminDatabaseId(databaseId);
  const byDb = getOrCreateAppDbMap(app);
  const existing = byDb.get(normalizedDbId);
  if (existing !== undefined) return existing;
  const wrapped = buildAppFirestoreInstance(app, normalizedDbId);
  byDb.set(normalizedDbId, wrapped);
  getOrCreateAppSettingsMap(app).set(normalizedDbId, undefined);
  return wrapped;
}

export function initializeFirestore(
  app: PyricAdminApp,
  settings?: AdminFirestoreSettings,
  databaseId?: string,
): SandboxFirestore {
  assertAdminAppActive(app);
  const normalizedDbId = resolveOptionalAdminDatabaseId(databaseId);
  const byDb = getOrCreateAppDbMap(app);
  const settingsByDb = getOrCreateAppSettingsMap(app);
  const requestedPreferRest = settings?.preferRest;
  const existing = byDb.get(normalizedDbId);
  if (existing !== undefined) {
    const initialPreferRest = settingsByDb.get(normalizedDbId);
    if (requestedPreferRest !== initialPreferRest) {
      throw createAdminGrpcError(
        GrpcStatus.FAILED_PRECONDITION as number,
        'initializeFirestore() has already been called with different options. To avoid this error, call initializeFirestore() with the same options as when it was originally called, or call getFirestore() to return the already initialized instance.',
      );
    }
    if (settings !== undefined) {
      applyAdminFirestoreSettings(existing, settings, true);
    }
    return existing;
  }
  const wrapped = buildAppFirestoreInstance(app, normalizedDbId);
  if (settings !== undefined) {
    applyAdminFirestoreSettings(wrapped, settings, true);
  }
  byDb.set(normalizedDbId, wrapped);
  settingsByDb.set(normalizedDbId, requestedPreferRest);
  return wrapped;
}

/**
 * Narrow a `PyricAdminApp` to the {@link SandboxContext} the admin
 * firestore backend runs against. Sandbox apps expose their `Sandbox` --
 * LOCAL and REMOTE alike: the base resolvers are remote-aware (they
 * dispatch a remote-branded sandbox to the channel-backed arm), so no
 * guard is needed here.
 */
function adminAppToContext(app: PyricAdminApp): SandboxContext {
  if (isSandboxAdminApp(app)) {
    const candidateSandbox = (app as { sandbox?: unknown }).sandbox;
    if (
      candidateSandbox !== null &&
      typeof candidateSandbox === 'object' &&
      typeof (candidateSandbox as { withAuth?: unknown }).withAuth === 'function'
    ) {
      return app.sandbox.withAuth(null);
    }
  }
  throw new TypeError(
    `pyric-admin/firestore: expected a sandbox admin app from initializeApp(), received target '${String(app[ADMIN_APP_TARGET])}'.`,
  );
}

/**
 * Return the admin Firestore handle.
 *
 *   - `getFirestore(ctx)` -- the original context form (rules-APPLIED for the
 *     ctx's captured identity). Unchanged; idempotent per `SandboxContext`.
 *   - `getFirestore(app)` -- resolves a {@link PyricAdminApp}'s sandbox to the
 *     rules-BYPASS admin lens (firebase-admin parity, #394).
 *   - `getFirestore()` -- resolves the default app to the rules-BYPASS admin
 *     lens; throws `app/no-app` when nothing is initialized.
 */
export function getFirestore(ctx: SandboxContext, databaseId?: string): SandboxFirestore;
export function getFirestore(app?: PyricAdminApp, databaseId?: string): SandboxFirestore;
export function getFirestore(databaseId: string): SandboxFirestore;
export function getFirestore(
  target?: SandboxContext | PyricAdminApp | string,
  databaseId?: string,
): SandboxFirestore;
export function getFirestore(
  this: unknown,
  target?: SandboxContext | PyricAdminApp | string,
  databaseId?: string,
): SandboxFirestore {
  if (target === undefined) {
    return getAppFirestore(getDefaultServiceApp(), databaseId);
  }
  if (typeof target === 'string') {
    if (isCalledFromLegacyRootAdminNamespace(this)) {
      throw new TypeError(
        'pyric-admin/firestore: expected a PyricAdminApp from initializeApp() (or omit the argument for the default app).',
      );
    }
    return getAppFirestore(getDefaultServiceApp(), target);
  }
  if (typeof target === 'object' && target !== null && ADMIN_APP_TARGET in target) {
    return getAppFirestore(target as PyricAdminApp, databaseId);
  }
  if (target instanceof SandboxContextImpl) {
    const normalizedDbId = resolveOptionalAdminDatabaseId(databaseId);
    let byDb = ctxNamedFirestoreCache.get(target);
    if (byDb === undefined) {
      byDb = new Map<string, SandboxFirestore>();
      ctxNamedFirestoreCache.set(target, byDb);
    }
    const cached = byDb.get(normalizedDbId);
    if (cached !== undefined) {
      return cached;
    }
    const scopedCtx = createDatabaseScopedContext(target, normalizedDbId);
    const rawDb = baseGetFirestore(scopedCtx);
    if (!isRemoteSandbox(scopedCtx.sandbox)) {
      const bypassDb = baseGetAdminFirestore(scopedCtx.sandbox);
      registerBypassExistenceReader(
        rawDb,
        async (docPath) => (await bypassDb.doc(docPath).get()).exists,
      );
    }
    const wrapped = wrapRootHandle(
      rawDb,
      scopedCtx.sandbox,
      false,
      undefined,
      normalizedDbId,
      target.sandbox,
    );
    byDb.set(normalizedDbId, wrapped);
    return wrapped;
  }
  throw new TypeError(
    'pyric-admin/firestore: expected a PyricAdminApp from initializeApp() or a SandboxContext (or omit the argument for the default app).',
  );
}

export function getAdminFirestore(ctx: SandboxContext, databaseId?: string): SandboxFirestore;
export function getAdminFirestore(sandbox: Sandbox, databaseId?: string): SandboxFirestore;
export function getAdminFirestore(
  target: SandboxContext | Sandbox,
  databaseId?: string,
): SandboxFirestore {
  const normalizedDbId = resolveOptionalAdminDatabaseId(databaseId);
  let originalSb: Sandbox;
  let scopedSb: Sandbox;
  let resolvedTarget: SandboxContext | Sandbox;
  if (target instanceof SandboxContextImpl) {
    originalSb = target.sandbox;
    const scopedCtx = createDatabaseScopedContext(target, normalizedDbId);
    scopedSb = scopedCtx.sandbox;
    resolvedTarget = scopedCtx;
  } else {
    originalSb = target as Sandbox;
    const scopedSandbox = createDatabaseScopedSandbox(originalSb, normalizedDbId);
    scopedSb = scopedSandbox;
    resolvedTarget = scopedSandbox;
  }
  return wrapRootHandle(
    baseGetAdminFirestore(resolvedTarget as SandboxContext),
    scopedSb,
    false,
    undefined,
    normalizedDbId,
    originalSb,
  );
}

export { adminOnSnapshot as onSnapshot };
