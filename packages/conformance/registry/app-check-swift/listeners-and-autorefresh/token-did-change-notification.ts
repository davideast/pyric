import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Notification.Name.AppCheckTokenDidChange / AppCheckTokenNotificationKey / AppCheckAppNameNotificationKey',
  behavior: 'Posts FIRAppCheckAppCheckTokenDidChangeNotification with the refreshed JWT string and FirebaseApp.name in userInfo whenever a standard token changes, while skipping cached hits and limited-use mints.',
  featureKeys: [
    'AppCheckTokenDidChange',
    'AppCheckTokenDidChangeNotification',
    'AppCheckTokenNotificationKey',
    'AppCheckAppNameNotificationKey',
  ],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (cachingForceRefreshExpiryLimitedUseAndNotifications) and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
