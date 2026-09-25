/**
 * `pyric-admin/instance-id`: a deferred entry for `firebase-admin/instance-id`.
 *
 * The sandbox does not model Instance ID. Every value `firebase-admin/instance-id`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  FirebaseInstanceIdError, InstanceId, InstanceIdClientErrorCode, getInstanceId,
} = deferredAdminEntry('instance-id');
