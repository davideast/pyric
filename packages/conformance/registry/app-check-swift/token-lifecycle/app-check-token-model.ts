import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'AppCheckToken(token:expirationDate:) / expirationDate / expireTimeMillis',
  behavior: 'Models the minted JWT string and Date expiration timestamp with NSObject equality/hashing and epoch-millisecond conversion.',
  featureKeys: ['AppCheckToken', 'expirationDate'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift` (mintsRealSandboxAppCheckJwtsOverLiveWebSocket).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
