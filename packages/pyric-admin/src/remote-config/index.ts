/**
 * `pyric-admin/remote-config`: a deferred entry for `firebase-admin/remote-config`.
 *
 * The sandbox does not model Remote Config. Every value `firebase-admin/remote-config`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  CustomSignalOperator, PercentConditionOperator, RemoteConfig,
  RemoteConfigFetchResponse, getRemoteConfig,
} = deferredAdminEntry('remote-config');
