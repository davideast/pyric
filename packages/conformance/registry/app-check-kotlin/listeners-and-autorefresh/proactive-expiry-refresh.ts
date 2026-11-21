import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAppCheck background auto-refresh scheduler',
  behavior: 'Schedules background token renewal ahead of token expiration (up to 5 minutes before expireTimeMillis) when isTokenAutoRefreshEnabled is true and notifies registered listeners.',
  featureKeys: ['setTokenAutoRefreshEnabledRespectsDataCollectionFlagAndRefreshesExpiringToken'],
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (setTokenAutoRefreshEnabledRespectsDataCollectionFlagAndRefreshesExpiringToken).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
  ],
});
