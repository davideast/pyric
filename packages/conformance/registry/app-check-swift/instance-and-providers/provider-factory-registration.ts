import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'AppCheck.setAppCheckProviderFactory(_:) / AppCheck.providerFactory',
  behavior: 'Registers the process-wide AppCheckProviderFactory consulted when instantiating AppCheck for a FirebaseApp (defaulting to DeviceCheckProviderFactory) and returns nil from AppCheck.appCheck(app:) when nil.',
  featureKeys: ['setAppCheckProviderFactory', 'providerFactory'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (singletonIdentityAndAppScoping) and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket, sharedFirebaseAppServicesInteroperateWithAppCheck).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
