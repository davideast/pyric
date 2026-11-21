import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAppCheck.getAppCheckToken(forceRefresh = true)',
  behavior: 'Bypasses the cached session token, mints a fresh RS256 App Check JWT with a distinct jti claim, updates the standard token cache, and notifies registered AppCheckListeners.',
  featureKeys: ['forceRefresh', 'FirebaseAppCheck.getAppCheckToken'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
