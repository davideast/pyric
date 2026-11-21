import { row } from './section.ts';

export default row({
  order: 50,
  api: 'AppCheckProvider / AppCheckProviderFactory (custom implementation)',
  behavior: 'Bridges completion-handler AppCheckProvider conformers (including non-Sendable Objective-C/Swift conformers) to async getToken() and falls back getLimitedUseToken() to getToken() when unoverridden.',
  featureKeys: ['AppCheckProvider', 'AppCheckProviderFactory'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (cachingForceRefreshExpiryLimitedUseAndNotifications) and `packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift',
  ],
});
