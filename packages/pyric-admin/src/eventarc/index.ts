/**
 * `pyric-admin/eventarc`: a deferred entry for `firebase-admin/eventarc`.
 *
 * The sandbox does not model Eventarc. Every value `firebase-admin/eventarc`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  Channel, Eventarc, getEventarc,
} = deferredAdminEntry('eventarc');
