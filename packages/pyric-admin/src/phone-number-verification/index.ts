/**
 * `pyric-admin/phone-number-verification`: a deferred entry for `firebase-admin/phone-number-verification`.
 *
 * The sandbox does not model Phone Number Verification. Every value `firebase-admin/phone-number-verification`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  PhoneNumberVerification, getPhoneNumberVerification,
} = deferredAdminEntry('phone-number-verification');
