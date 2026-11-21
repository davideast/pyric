import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'AppCheck.isTokenAutoRefreshEnabled',
  behavior: 'Reads Info.plist FirebaseAppCheckTokenAutoRefreshEnabled by default and enables or cancels scheduled background renewal tasks when mutated at runtime.',
  featureKeys: ['isTokenAutoRefreshEnabled'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (autoRefreshRenewsExpiringToken) and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
