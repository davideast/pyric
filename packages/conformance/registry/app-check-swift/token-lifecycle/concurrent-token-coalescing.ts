import { row } from './section.ts';

export default row({
  order: 30,
  api: 'AppCheck.token(forcingRefresh: false) (concurrent in-flight coalescing)',
  behavior: 'Coalesces concurrent non-forced token(forcingRefresh: false) callers onto a single in-flight provider request so only one token is minted and one notification posted.',
  featureKeys: ['cachingForceRefreshExpiryLimitedUseAndNotifications'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (cachingForceRefreshExpiryLimitedUseAndNotifications).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
  ],
});
