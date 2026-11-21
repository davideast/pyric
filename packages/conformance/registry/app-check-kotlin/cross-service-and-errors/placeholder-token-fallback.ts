import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAppCheck.getTokenForSharedRequest() placeholder fallback',
  behavior: 'Substitutes APP_CHECK_PLACEHOLDER_TOKEN when an installed AppCheckProvider fails during shared-service request interception so downstream services surface structured attestation errors.',
  featureKeys: ['APP_CHECK_PLACEHOLDER_TOKEN'],
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt` (attachesStandardLimitedUseAndPlaceholderAppCheckClaimsAutomatically).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt',
  ],
});
