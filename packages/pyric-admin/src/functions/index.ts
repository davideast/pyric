/**
 * `pyric-admin/functions`: a deferred entry for `firebase-admin/functions`.
 *
 * The sandbox does not model Cloud Functions task queues. Every value `firebase-admin/functions`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  Functions, TaskQueue, getFunctions,
} = deferredAdminEntry('functions');
