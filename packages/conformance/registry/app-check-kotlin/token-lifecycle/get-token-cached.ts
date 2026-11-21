import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAppCheck.getAppCheckToken(forceRefresh = false)',
  behavior: 'Mints a ~1-hour RS256 App Check JWT bound to applicationId and projectId on cache miss or expiry, and returns the cached valid AppCheckToken on subsequent calls without extra bridge round-trips.',
  featureKeys: ['getAppCheckToken'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp), with `pyric-admin/app-check` `verifyToken()` validation in `packages/cli/test/serve/native-kotlin-appcheck-conformance.test.ts`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
