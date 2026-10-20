/**
 * Unmodeled `firebase-admin/*` subpaths and their `App`-bound service handles.
 *
 * Under `pyric sandbox`, every `firebase-admin/*` import resolves to the same
 * subpath of `pyric-admin`. Many server codebases initialize unmodeled services
 * unconditionally at module load (`export const appCheck = getAppCheck(app)`)
 * while never invoking methods on that handle on sandboxed request paths.
 *
 * Mirroring upstream's container contract keeps module initialization faithful
 * without ever reaching production Firebase:
 * - `get<Service>(app?)` resolves the active `PyricAdminApp` (throwing
 *   `FirebaseAppError` `app/no-app` before `initializeApp()`, or
 *   `app/app-deleted` after `deleteApp()`), caches one handle per app, and
 *   exposes `.app`.
 * - Every method on the returned handle is wired via `defineDeferredMembers` so
 *   calling it throws synchronously or returns a rejected `Promise` with
 *   `PyricDeferredApiError` naming `<Class>.<method>` and `pyric-admin/<subpath>`.
 * - Helper classes, enums, and direct `new <Service>()` calls throw
 *   `PyricDeferredApiError` naming the subpath.
 */
import {
  deferredEntry,
  defineDeferredMembers,
  PyricDeferredApiError,
  type DeferredApi,
  type DeferredMembers,
} from 'pyric/app/internal';
import { getApp, type PyricAdminApp } from './app/index.js';
import { assertAdminAppActive } from './app/lifecycle.js';

export { PyricDeferredApiError };

/** Private construction token so `new <Service>()` throws while `get<Service>(app)` succeeds. */
export const DEFERRED_SERVICE_TOKEN: unique symbol = Symbol('pyric.admin.deferredService');

/** The message every unmodeled `firebase-admin` export raises when called or constructed directly. */
export function deferredAdminMessage(subpath: string): string {
  return (
    `pyric: 'firebase-admin/${subpath}' is not mirrored by the local sandbox, so its calls fail here. ` +
    'Imports resolve so module graphs load. Code that needs this service runs against Firebase outside ' +
    'the sandbox: start it without `pyric sandbox`, or keep the call off the code path the sandbox runs.'
  );
}

/**
 * The export bag for non-service exports of one deferred `firebase-admin`
 * subpath (helper classes, error classes, enum-like constants).
 */
export function deferredAdminEntry(subpath: string): Record<string, DeferredApi> {
  return deferredEntry(subpath, deferredAdminMessage(subpath));
}

/** Resolve the default or explicit admin `App` and assert it has not been deleted. */
export function resolveActiveAdminApp(app?: PyricAdminApp): PyricAdminApp {
  const resolved = app ?? getApp();
  assertAdminAppActive(resolved);
  return resolved;
}

/** Guard direct `new <Service>()` construction while allowing `wireDeferredService` to mint handles. */
export function guardDeferredServiceApp(
  subpath: string,
  className: string,
  args: readonly unknown[],
): PyricAdminApp {
  if (args[0] !== DEFERRED_SERVICE_TOKEN) {
    throw new PyricDeferredApiError(subpath, className, deferredAdminMessage(subpath));
  }
  return args[1] as PyricAdminApp;
}

/**
 * Attach deferred member stubs onto `ctor.prototype` and return a per-app
 * cached `get<Service>(app?)` factory matching `firebase-admin`'s
 * `firebaseApp.getOrInitService(...)`.
 */
export function wireDeferredService<T extends object>(
  ctor: { prototype: T },
  subpath: string,
  owner: string,
  members: DeferredMembers,
): (app?: PyricAdminApp) => T {
  defineDeferredMembers(ctor.prototype, `pyric-admin/${subpath}`, owner, members);
  const instances = new WeakMap<PyricAdminApp, T>();
  return function getDeferredService(app?: PyricAdminApp): T {
    const resolved = resolveActiveAdminApp(app);
    const existing = instances.get(resolved);
    if (existing !== undefined) return existing;
    const created = new (ctor as unknown as new (...ctorArgs: unknown[]) => T)(
      DEFERRED_SERVICE_TOKEN,
      resolved,
    );
    instances.set(resolved, created);
    return created;
  };
}
