import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'HttpsCallableReference.stream(data?) / StreamResponse.Message / StreamResponse.Result',
  behavior: 'Streams callable responses over Accept: text/event-stream as Flow<StreamResponse>, emitting incremental StreamResponse.Message chunks, terminal StreamResponse.Result, and cancelling the HTTP call when Flow collection stops early.',
  featureKeys: ['HttpsCallableReference.stream', 'StreamResponse.Message', 'StreamResponse.Result'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (streams SSE Message and Result frames and propagates mid-stream HttpsError) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
