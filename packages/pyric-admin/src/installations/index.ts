/**
 * `pyric-admin/installations`: a deferred entry for `firebase-admin/installations`.
 *
 * The sandbox does not model Firebase Installations. Every value `firebase-admin/installations`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  FirebaseInstallationsError, Installations, InstallationsClientErrorCode,
  getInstallations,
} = deferredAdminEntry('installations');
