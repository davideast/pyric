import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctions.getHttpsCallable(name, options?) / HttpsCallableReference.call(data?) / HttpsCallableResult.data',
  behavior: 'Invokes v2 onCall and v1 https.onCall endpoints via {"data": ...} JSON POST and unwraps either result or data response envelopes into HttpsCallableResult.',
  featureKeys: ['getHttpsCallable', 'HttpsCallableReference', 'HttpsCallableResult'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt` (proves v2 and v1 callable functions Auth AppCheck HttpsError timeout and SSE streaming against live Pyric host).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
