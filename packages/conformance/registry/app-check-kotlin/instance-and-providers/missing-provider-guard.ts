import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAppCheck.getAppCheckToken() / getLimitedUseAppCheckToken() (before provider install)',
  behavior: 'Fails returned Task immediately with FirebaseException("No AppCheckProvider installed.") when called before installAppCheckProviderFactory.',
  featureKeys: ['No AppCheckProvider installed'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (getTokenBeforeInstallingProviderFailsWithFirebaseException) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
