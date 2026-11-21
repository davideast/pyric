import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI.firebaseAI(app:backend:useLimitedUseAppCheckTokens:) / reset() / disconnect()",
  behavior: "Caches FirebaseAI instances per (FirebaseApp, Backend, useLimitedUseAppCheckTokens), supports isolated test/engine handles, and disconnects underlying WebSocket sessions on disconnect() and reset().",
  featureKeys: ["FirebaseAI.firebaseAI", "FirebaseAI.reset", "FirebaseAI.disconnect"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (instanceCachingAndModelNormalization) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
