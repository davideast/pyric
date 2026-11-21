import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'AppCheck.limitedUseToken() / limitedUseToken(completion:)',
  behavior: 'Mints a ~5-minute single-use RS256 App Check JWT with a unique jti claim without overwriting the cached standard token or posting AppCheckTokenDidChange.',
  featureKeys: ['limitedUseToken'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift`, with single-use `verifyToken(jwt, { consume: true })` replay detection verified in `packages/cli/test/serve/native-swift-appcheck-conformance.test.ts`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
