import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI(useLimitedUseAppCheckTokens:enforceAppCheck:) + PyricAppCheck integration",
  behavior: "Attaches cached standard or fresh single-use RS256 App Check JWTs onto unary and streaming AI frames and rejects unauthenticated requests with HTTP 401 UNAUTHENTICATED BackendError.",
  featureKeys: ["FirebaseAI.useLimitedUseAppCheckTokens", "FirebaseAI.enforceAppCheck"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift` and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
