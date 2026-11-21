import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HttpsCallableReference.setTimeout / getTimeout / withTimeout(timeout, units)',
  behavior: 'Defaults callable timeouts to 70,000 ms, clones immutable per-call timeout overrides via withTimeout without mutating the base reference, and fails slow calls with Code.DEADLINE_EXCEEDED.',
  featureKeys: ['withTimeout', 'setTimeout', 'DEADLINE_EXCEEDED'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
