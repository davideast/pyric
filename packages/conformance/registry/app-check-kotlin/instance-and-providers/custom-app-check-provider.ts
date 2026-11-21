import { row } from './section.ts';

const AI_LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-kotlin-ai-conformance.test.ts';

export default row({
  order: 40,
  api: 'AppCheckProvider / AppCheckProviderFactory (custom implementation)',
  behavior: 'Supports user-supplied AppCheckProviderFactory and AppCheckProvider implementations vending custom AppCheckToken subclasses across standard, limited-use, and shared-service requests.',
  featureKeys: ['AppCheckProvider', 'customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring), `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt` (verifiesStandardLimitedUseAndRejectedAppCheckClaimsAgainstLiveAiBroker).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt',
    AI_LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [AI_LIVE_HOST_CONFORMANCE_TEST],
});
