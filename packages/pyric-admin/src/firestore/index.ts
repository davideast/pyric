/**
 * `pyric-admin/firestore` — Admin-shape Firestore.
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
 * RULES-BYPASS PARITY (#394): the two APP-resolution forms — `getFirestore(app)`
 * and no-arg `getFirestore()` — mirror `firebase-admin/firestore`'s
 * `getFirestore(app?)`, and REAL firebase-admin bypasses security rules. So both
 * app forms resolve to the rules-BYPASS admin lens (`getAdminFirestore` →
 * `{ mode: 'admin' }`), exactly as `pyric-admin/database`'s `getDatabase(app)`
 * and `pyric-admin/storage`'s `getStorage(app)` already do. Previously the app
 * forms routed through the anon-lens `getFirestore(sandbox.withAuth(null))`,
 * which evaluates `request.auth == null` and is DENIED by any real ruleset — a
 * deny-direction divergence from production that blocked the RTDB-trigger →
 * Firestore-stamp pattern (a Cloud Function's admin write).
 *
 * The `getFirestore(ctx)` CONTEXT form is UNCHANGED and stays rules-ENFORCED
 * (its captured identity is load-bearing for the rules-simulation suite). No
 * page ever reaches this module: a page's `firebase/firestore` resolves to
 * `pyric/firestore` (the rules-enforced client), not `pyric-admin`; only the
 * `firebase-admin/*` → `pyric-admin/*` swap in the trusted functions child
 * imports this. See {@link getFirestore}.
 */
export * from 'pyric/sandbox/admin-firestore';

import {
  getFirestore as baseGetFirestore,
  getAdminFirestore as baseGetAdminFirestore,
  type SandboxFirestore,
} from 'pyric/sandbox/admin-firestore';
import type { SandboxContext } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  getApp,
  isSandboxAdminApp,
  type PyricAdminApp,
} from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { defineDeferredMembers, deferredExport, type DeferredMembers } from 'pyric/app/internal';

// ─── Deferred surface ─────────────────────────────────────────────────────
//
// `firebase-admin/firestore` values and `Firestore` methods the sandbox does
// not model. Each fails with a `PyricDeferredApiError` naming it instead of
// reading as `undefined` at the call site.

const SUBPATH = 'pyric-admin/firestore';

export const AggregateField = deferredExport(SUBPATH, 'AggregateField');
export const Filter = deferredExport(SUBPATH, 'Filter');
export const GeoPoint = deferredExport(SUBPATH, 'GeoPoint');
export const GrpcStatus = deferredExport(SUBPATH, 'GrpcStatus');
export const initializeFirestore = deferredExport(SUBPATH, 'initializeFirestore');
export const setLogFunction = deferredExport(SUBPATH, 'setLogFunction');

const FIRESTORE_DEFERRED_MEMBERS: DeferredMembers = {
  async: ['getAll', 'listCollections', 'recursiveDelete', 'terminate'],
  sync: ['bulkWriter', 'bundle', 'settings'],
};

/** Define the deferred `Firestore` methods on a handle either arm built. */
function withDeferredMembers(db: SandboxFirestore): SandboxFirestore {
  defineDeferredMembers(db, SUBPATH, 'Firestore', FIRESTORE_DEFERRED_MEMBERS);
  return db;
}

/** Narrow a `PyricAdminApp` to the {@link SandboxContext} the admin
 *  firestore backend runs against. Sandbox apps expose their `Sandbox` —
 *  LOCAL and REMOTE alike: the base resolvers are remote-aware (they
 *  dispatch a remote-branded sandbox to the channel-backed arm), so no
 *  guard is needed here. The context's captured auth is IRRELEVANT on the
 *  admin path (rules are bypassed, so no rule reads `request.auth`); it is
 *  normalised to `withAuth(null)` only to obtain a context. Prod apps
 *  require firebase-admin's real Firestore, which the in-process backend
 *  does not model. */
function adminAppToContext(app: PyricAdminApp): SandboxContext {
  if (isSandboxAdminApp(app)) {
    return app.sandbox.withAuth(null);
  }
  throw new Error(
    'pyric-admin/firestore: getFirestore() default-app resolution supports ' +
      'sandbox apps; a prod app requires firebase-admin/firestore directly.',
  );
}

/**
 * Return the admin Firestore handle.
 *
 *   - `getFirestore(ctx)` — the original context form (rules-APPLIED for the
 *     ctx's captured identity). Unchanged; idempotent per `SandboxContext`.
 *     This is the pyric-internal rules-simulation shape, not a firebase-admin
 *     shape, so it keeps rule evaluation.
 *   - `getFirestore(app)` — resolves a {@link PyricAdminApp}'s sandbox to the
 *     rules-BYPASS admin lens (firebase-admin parity, #394).
 *   - `getFirestore()` — resolves the default app to the rules-BYPASS admin
 *     lens; throws `app/no-app` when nothing is initialized.
 *
 * The app forms mirror `firebase-admin/firestore`'s `getFirestore(app?)`,
 * which bypasses security rules — so a Cloud Function's admin write lands the
 * same way it does in production, instead of being denied as `request.auth ==
 * null` by the sandbox's anon lens (the #394 deny-direction divergence).
 */
export function getFirestore(
  target?: SandboxContext | PyricAdminApp,
): SandboxFirestore {
  if (target === undefined) {
    return withDeferredMembers(baseGetAdminFirestore(adminAppToContext(getApp())));
  }
  if (typeof target === 'object' && target !== null && ADMIN_APP_TARGET in target) {
    const app = target as PyricAdminApp;
    assertAdminAppActive(app);
    return withDeferredMembers(baseGetAdminFirestore(adminAppToContext(app)));
  }
  return withDeferredMembers(baseGetFirestore(target as SandboxContext));
}
