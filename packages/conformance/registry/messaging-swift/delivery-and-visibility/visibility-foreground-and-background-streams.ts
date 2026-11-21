import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "setVisibility(_:) / foregroundMessages / backgroundMessages / RemoteMessagingMessage",
  behavior: "Synchronizes client MessagingVisibilityState (.visible or .hidden) with MessagingBroker and delivers decoded RemoteMessagingMessage values (messageID, from, data, notification, collapseKey, fcmOptions) exclusively to foregroundMessages or backgroundMessages.",
  featureKeys: ["Messaging.setVisibility", "Messaging.foregroundMessages", "Messaging.backgroundMessages", "RemoteMessagingMessage"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
