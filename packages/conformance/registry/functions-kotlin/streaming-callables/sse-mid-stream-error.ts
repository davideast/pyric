import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HttpsCallableReference.stream() mid-stream HttpsError termination',
  behavior: 'Closes the SSE Flow with a mapped FirebaseFunctionsException preserving code, message, and details after delivering earlier StreamResponse.Message chunks when a mid-stream error frame arrives.',
  featureKeys: ['fromParsedErrorEnvelope'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
