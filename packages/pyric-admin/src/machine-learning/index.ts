/**
 * `pyric-admin/machine-learning`: a deferred entry for `firebase-admin/machine-learning`.
 *
 * The sandbox does not model Firebase ML. Every value `firebase-admin/machine-learning`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  MachineLearning, Model, getMachineLearning,
} = deferredAdminEntry('machine-learning');
