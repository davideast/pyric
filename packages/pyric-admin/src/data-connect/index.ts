/**
 * `pyric-admin/data-connect`: a deferred entry for `firebase-admin/data-connect`.
 *
 * The sandbox does not model Data Connect. Every value `firebase-admin/data-connect`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  DataConnect, getDataConnect, validateAdminArgs,
} = deferredAdminEntry('data-connect');
