/**
 * The `firebase-admin` subpaths the sandbox does not mirror.
 *
 * Under `pyric sandbox`, every `firebase-admin/*` import resolves to the same
 * subpath of `pyric-admin`. For a service the sandbox does not model, that
 * subpath is a deferred entry: it resolves and every export links, so a module
 * graph that imports the service still loads, and using any export throws a
 * `PyricDeferredApiError` that names the subpath. The import is never passed
 * through to the real `firebase-admin`, which would reach production from
 * inside the sandbox.
 */
import { deferredEntry, type DeferredApi } from 'pyric/app/internal';

export { PyricDeferredApiError } from 'pyric/app/internal';

/** The message every export of a deferred `firebase-admin` subpath throws. */
function deferredAdminMessage(subpath: string): string {
  return (
    `pyric: 'firebase-admin/${subpath}' is not mirrored by the local sandbox, so its calls fail here. ` +
    'Imports resolve so module graphs load. Code that needs this service runs against Firebase outside ' +
    'the sandbox: start it without `pyric sandbox`, or keep the call off the code path the sandbox runs.'
  );
}

/**
 * The export bag for one deferred `firebase-admin` subpath. Each entry
 * destructures the names the real subpath exports off it.
 *
 * @param subpath - The subpath without the `firebase-admin/` prefix.
 */
export function deferredAdminEntry(subpath: string): Record<string, DeferredApi> {
  return deferredEntry(subpath, deferredAdminMessage(subpath));
}
