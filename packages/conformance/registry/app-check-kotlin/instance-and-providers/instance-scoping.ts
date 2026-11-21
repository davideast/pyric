import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAppCheck.getInstance() / FirebaseAppCheck.getInstance(firebaseApp) / Firebase.appCheck',
  behavior: 'Returns a cached FirebaseAppCheck singleton scoped per FirebaseApp name, registers the shared-app token provider, and disposes instances on app reset.',
  featureKeys: ['FirebaseAppCheck.getInstance', 'Firebase.appCheck'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (singletonIdentityAndKtxExtensionsAreScopedPerFirebaseApp) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
