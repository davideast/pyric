import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAppCheck.getLimitedUseAppCheckToken()',
  behavior: 'Mints a ~5-minute single-use RS256 App Check JWT with a unique jti claim for replay-protected verification without mutating the cached standard token or firing AppCheckListeners.',
  featureKeys: ['getLimitedUseAppCheckToken'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt`, with single-use `verifyToken(jwt, { consume: true })` replay detection verified in `packages/cli/test/serve/native-kotlin-appcheck-conformance.test.ts`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
