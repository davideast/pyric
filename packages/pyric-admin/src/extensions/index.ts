/**
 * `pyric-admin/extensions`: a deferred entry for `firebase-admin/extensions`.
 *
 * The sandbox does not model Extensions. Every value `firebase-admin/extensions`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  Extensions, Runtime, getExtensions,
} = deferredAdminEntry('extensions');
