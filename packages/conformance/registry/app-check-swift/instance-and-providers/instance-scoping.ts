import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'AppCheck.appCheck() / AppCheck.appCheck(app:) / AppCheck.reset()',
  behavior: 'Returns per-FirebaseApp AppCheck singletons, tracks FirebaseApp.useEmulator bridge updates, and disposes instances cleanly on AppCheck.reset() or app deletion.',
  featureKeys: ['AppCheck.appCheck', 'AppCheck.reset'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (singletonIdentityAndAppScoping), `packages/swift-client/Tests/PyricAppCheckTests/CrossTargetSingletonIsolationTests.swift`, and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/CrossTargetSingletonIsolationTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
