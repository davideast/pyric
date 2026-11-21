import { row } from './section.ts';

export default row({
  order: 30,
  api: "onForegroundMessage(_:) / onBackgroundMessage(_:) / acknowledge(messageID:status:)",
  behavior: "Registers cancellable closure observers alongside AsyncStream consumers and records per-message delivery acknowledgments over the bridge.",
  featureKeys: ["Messaging.onForegroundMessage", "Messaging.onBackgroundMessage", "Messaging.acknowledge"],
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` (`Routes foreground and background streams, acknowledgments, sendBrokerMessage, appDidReceiveMessage, and...`).",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
  ],
});
