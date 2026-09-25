/**
 * `pyric-admin/app-check`: a deferred entry for `firebase-admin/app-check`.
 *
 * The sandbox does not model App Check. Every value `firebase-admin/app-check`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  AppCheck, getAppCheck,
} = deferredAdminEntry('app-check');
