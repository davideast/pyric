import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAppCheck.installAppCheckProviderFactory(factory, isTokenAutoRefreshEnabled?)',
  behavior: 'Installs an AppCheckProviderFactory on the target FirebaseApp, clears any previously cached token or in-flight mint, and applies the requested token auto-refresh state.',
  featureKeys: ['installAppCheckProviderFactory', 'AppCheckProviderFactory'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring, debugAndPlayIntegrityFactoriesMintViaBridgeAndAttachTokenToSharedAppRequests) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
