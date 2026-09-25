/**
 * `pyric-admin/project-management`: a deferred entry for `firebase-admin/project-management`.
 *
 * The sandbox does not model Project Management. Every value `firebase-admin/project-management`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  AndroidApp, AppPlatform, FirebaseProjectManagementError, IosApp, ProjectManagement,
  ShaCertificate, getProjectManagement,
} = deferredAdminEntry('project-management');
