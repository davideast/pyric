import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContentStream(_:) / AsyncThrowingStream<GenerateContentResponse, any Error>",
  behavior: "Streams incremental GenerateContentResponse chunks over worker-sub and cancels active bridge subscriptions (worker-unsub) on consumer break or Task cancellation.",
  featureKeys: ["GenerativeModel.generateContentStream"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift` (streamGenerateContentAndEarlyUnsubscribe) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
