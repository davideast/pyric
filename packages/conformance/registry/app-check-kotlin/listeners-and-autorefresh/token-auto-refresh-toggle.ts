import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAppCheck.setTokenAutoRefreshEnabled(enabled) / isTokenAutoRefreshEnabled',
  behavior: 'Toggles token auto-refresh demand and gates effective isTokenAutoRefreshEnabled on FirebaseApp.isDataCollectionDefaultEnabled.',
  featureKeys: ['setTokenAutoRefreshEnabled', 'isTokenAutoRefreshEnabled'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (setTokenAutoRefreshEnabledRespectsDataCollectionFlagAndRefreshesExpiringToken) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
