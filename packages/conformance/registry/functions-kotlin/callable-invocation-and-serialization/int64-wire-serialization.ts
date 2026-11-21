import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FunctionsSerializer (Int64Value / UInt64Value 64-bit Long & container codecs)',
  behavior: 'Wraps Kotlin Long values as google.protobuf.Int64Value JSON envelopes and decodes Int64Value and UInt64Value back to Long with full 64-bit precision alongside Maps, Lists, and primitive arrays.',
  featureKeys: ['Int64Value', 'UInt64Value', 'FunctionsSerializer'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`, plus `packages/cli/test/serve/native-kotlin-functions-conformance.test.ts`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
