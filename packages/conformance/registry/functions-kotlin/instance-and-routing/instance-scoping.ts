import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctions.getInstance(...) / Firebase.functions(...)',
  behavior: 'Caches FirebaseFunctions singletons keyed by (app.name, regionOrCustomDomain), defaulting to us-central1, and parses HTTP(S) strings into customDomain.',
  featureKeys: ['FirebaseFunctions.getInstance', 'Firebase.functions'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (getInstance KTX caching customDomain URL rewriting and off-machine refusal) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
