import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'AppCheck.token(forcingRefresh: true)',
  behavior: 'Bypasses the cached standard token, mints a fresh RS256 App Check JWT with a distinct jti claim, updates the cache, and posts Notification.Name.AppCheckTokenDidChange.',
  featureKeys: ['forcingRefresh'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
