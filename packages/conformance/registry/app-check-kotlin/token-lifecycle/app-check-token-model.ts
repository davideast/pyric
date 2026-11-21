import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'AppCheckToken.token / AppCheckToken.expireTimeMillis / component1() / component2()',
  behavior: 'Exposes the minted JWT string and epoch-millisecond expiration timestamp on AppCheckToken along with KTX destructuring operators component1() and component2().',
  featureKeys: ['AppCheckToken', 'expireTimeMillis', 'component1', 'component2'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` (customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt` (mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
