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
import { adminRawDbProjectId, adminRawDbSandbox } from './admin-handle-registry.js';
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
): SandboxFirestore {
  if (sandbox !== undefined) {
    adminRawDbSandbox.set(db, sandbox);
  }
  if (projectId !== undefined && projectId.length > 0) {
    adminRawDbProjectId.set(db, projectId);
  }
  return wrapAdminFirestoreHandle(db, appBacked);
}

const appFirestoreCache = new WeakMap<PyricAdminApp, SandboxFirestore>();

function assertValidOptionalDatabaseId(databaseId: unknown): void {
  let effectiveDatabaseId: unknown = '(default)';
  if (databaseId) {
    effectiveDatabaseId = databaseId;
  }
  if (typeof effectiveDatabaseId !== 'string') {
    throw createAdminGrpcError(
      GrpcStatus.INVALID_ARGUMENT as number,
      'Value for argument "settings.databaseId" is not a valid string.',
    );
  }
}

function getAppFirestore(app: PyricAdminApp, databaseId?: unknown): SandboxFirestore {
  assertAdminAppActive(app);
  assertValidOptionalDatabaseId(databaseId);
  const existing = appFirestoreCache.get(app);
  if (existing !== undefined) return existing;
  const ctx = adminAppToContext(app);
  const rawDb = baseGetAdminFirestore(ctx);
  let projectId = 'pyric-sandbox';
  if (typeof app.options?.projectId === 'string' && app.options.projectId.length > 0) {
    projectId = app.options.projectId;
  }
  const wrapped = wrapRootHandle(rawDb, ctx.sandbox, true, projectId);
  appFirestoreCache.set(app, wrapped);
  return wrapped;
}

export function initializeFirestore(
  app: PyricAdminApp,
  settings?: AdminFirestoreSettings,
  databaseId?: string,
): SandboxFirestore {
  const handle = getAppFirestore(app, databaseId);
  if (settings !== undefined) {
    applyAdminFirestoreSettings(handle, settings, true);
  }
  return handle;
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
export function getFirestore(
  target?: SandboxContext | PyricAdminApp,
  databaseId?: string,
): SandboxFirestore {
  if (target === undefined) {
    return getAppFirestore(getDefaultServiceApp(), databaseId);
  }
  if (typeof target === 'object' && target !== null && ADMIN_APP_TARGET in target) {
    return getAppFirestore(target as PyricAdminApp, databaseId);
  }
  if (target instanceof SandboxContextImpl) {
    const rawDb = baseGetFirestore(target);
    if (!isRemoteSandbox(target.sandbox)) {
      const bypassDb = baseGetAdminFirestore(target.sandbox);
      registerBypassExistenceReader(
        rawDb,
        async (docPath) => (await bypassDb.doc(docPath).get()).exists,
      );
    }
    return wrapRootHandle(rawDb, target.sandbox);
  }
  throw new TypeError(
    'pyric-admin/firestore: expected a PyricAdminApp from initializeApp() or a SandboxContext (or omit the argument for the default app).',
  );
}

export function getAdminFirestore(ctx: SandboxContext): SandboxFirestore;
export function getAdminFirestore(sandbox: Sandbox): SandboxFirestore;
export function getAdminFirestore(target: SandboxContext | Sandbox): SandboxFirestore {
  let sb: Sandbox | undefined;
  if (target instanceof SandboxContextImpl) {
    sb = target.sandbox;
  } else {
    sb = target as Sandbox;
  }
  return wrapRootHandle(baseGetAdminFirestore(target as SandboxContext), sb);
}

export { adminOnSnapshot as onSnapshot };
