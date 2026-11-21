import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HttpsCallableOptions / setLimitedUseAppCheckTokens (X-Firebase-AppCheck)',
  behavior: 'Attaches cached standard X-Firebase-AppCheck tokens when an AppCheckProvider is installed and mints single-use tokens per call when limitedUseAppCheckTokens is enabled via Builder or Kotlin DSL.',
  featureKeys: ['HttpsCallableOptions', 'limitedUseAppCheckTokens', 'setLimitedUseAppCheckTokens'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt` (consumeAppCheckToken replay protection).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
