import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'AppCheck.token(forcingRefresh: false) / token(forcingRefresh:completion:)',
  behavior: 'Mints a ~1-hour RS256 App Check JWT bound to googleAppID and projectID on cache miss or expiry, and returns the cached AppCheckToken on subsequent async or completion-handler calls.',
  featureKeys: ['AppCheck.token'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (cachingForceRefreshExpiryLimitedUseAndNotifications) and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket), with `pyric-admin/app-check` `verifyToken()` validation in `packages/cli/test/serve/native-swift-appcheck-conformance.test.ts`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
