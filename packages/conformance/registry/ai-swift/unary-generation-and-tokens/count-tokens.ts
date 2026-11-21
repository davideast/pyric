import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "GenerativeModel.countTokens(_:) / CountTokensResponse",
  behavior: "Counts prompt tokens deterministically via ai.countTokens and decodes totalTokens and per-modality promptTokensDetails.",
  featureKeys: ["GenerativeModel.countTokens", "CountTokensResponse"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift` and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
