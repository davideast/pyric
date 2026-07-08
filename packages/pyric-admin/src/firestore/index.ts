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
 */
export * from 'pyric/sandbox/admin-firestore';

import {
  getFirestore as baseGetFirestore,
  type SandboxFirestore,
} from 'pyric/sandbox/admin-firestore';
import type { SandboxContext } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  getApp,
  isSandboxAdminApp,
  type PyricAdminApp,
} from '../app/index.js';

/** Narrow a `PyricAdminApp` to the anonymous {@link SandboxContext} the
 *  admin firestore backend runs against. Sandbox apps expose their
 *  `Sandbox` — LOCAL and REMOTE alike: the base `getFirestore` is
 *  remote-aware (it dispatches a remote-branded sandbox to the
 *  channel-backed arm), so no guard is needed here. Prod apps require
 *  firebase-admin's real Firestore, which the in-process backend does
 *  not model. */
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
 *   - `getFirestore(ctx)` — the original context form (rules-applied for the
 *     ctx's captured identity). Unchanged; idempotent per `SandboxContext`.
 *   - `getFirestore(app)` — resolves a {@link PyricAdminApp}'s sandbox.
 *   - `getFirestore()` — resolves the default app; throws `app/no-app` when
 *     nothing is initialized.
 */
export function getFirestore(
  target?: SandboxContext | PyricAdminApp,
): SandboxFirestore {
  if (target === undefined) {
    return baseGetFirestore(adminAppToContext(getApp()));
  }
  if (typeof target === 'object' && target !== null && ADMIN_APP_TARGET in target) {
    return baseGetFirestore(adminAppToContext(target as PyricAdminApp));
  }
  return baseGetFirestore(target as SandboxContext);
}
