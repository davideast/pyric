import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "sendBrokerMessage(_:validateOnly:) / MessagingBrokerMessage",
  behavior: "Dispatches direct-token, topic, and boolean-condition ('swift_live' in topics && !('muted' in topics)) outbound messages through MessagingBroker, returning projects/<project>/messages/<id> identifiers while suppressing fanout when validateOnly is true.",
  featureKeys: ["Messaging.sendBrokerMessage", "MessagingBrokerMessage"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
