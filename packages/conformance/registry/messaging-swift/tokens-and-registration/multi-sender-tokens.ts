import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "retrieveFCMToken(forSenderID:) / deleteFCMToken(forSenderID:)",
  behavior: "Mints, caches, and revokes distinct 142-character FCM tokens scoped to secondary GCM/FCM sender IDs without disturbing the primary app registration token.",
  featureKeys: ["Messaging.retrieveFCMToken", "Messaging.deleteFCMToken"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
