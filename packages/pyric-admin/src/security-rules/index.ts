/**
 * `pyric-admin/security-rules`: a deferred entry for `firebase-admin/security-rules`.
 *
 * The sandbox does not model Security Rules management. Every value `firebase-admin/security-rules`
 * exports is present so imports link; using one throws `PyricDeferredApiError`.
 * See `../deferred.ts`.
 */
import { deferredAdminEntry } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export const {
  Ruleset, RulesetMetadataList, SecurityRules, getSecurityRules,
} = deferredAdminEntry('security-rules');
