import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "GenerativeModel.startChat(history:) / Chat.sendMessage(_:) / Chat.sendMessageStream(_:) / Chat.history",
  behavior: "Serializes multi-turn Chat requests in FIFO actor order, aggregates streamed thought and text chunks on completion, and leaves Chat.history unchanged when a turn is safety-blocked or fails.",
  featureKeys: ["GenerativeModel.startChat", "Chat", "Chat.sendMessage", "Chat.sendMessageStream", "Chat.history"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift` (chatAtomicHistoryUpdates) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIStreamChatAndAppCheckTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
