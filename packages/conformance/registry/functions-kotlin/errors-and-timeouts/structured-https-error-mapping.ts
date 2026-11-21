import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctionsException / Code (0..16) / details',
  behavior: 'Maps all 17 canonical gRPC status codes and HTTP fallback statuses into FirebaseFunctionsException, decodes protobuf-wrapped details, and maps unhandled server throws or unknown statuses to Code.INTERNAL.',
  featureKeys: ['FirebaseFunctionsException', 'FirebaseFunctionsException.Code'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (maps structured HttpsError details timeout and non-finite encoding errors) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
