import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAppCheck.addAppCheckListener(listener) / removeAppCheckListener(listener)',
  behavior: 'Delivers any valid cached AppCheckToken immediately upon registration, notifies active AppCheckListeners when standard tokens change, and halts delivery after removeAppCheckListener.',
  featureKeys: ['addAppCheckListener', 'removeAppCheckListener', 'AppCheckListener'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (listenersReceiveImmediateCachedTokenUpdatesAndRespectRemoval) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
