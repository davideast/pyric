import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Messaging.messaging() / Messaging.messaging(app:) / evictInstance(for:) / disconnect()",
  behavior: "Caches per-FirebaseApp Messaging singletons with isolated tokens, topic bindings, and delivery streams across default and named apps, and tears down active subscriptions on disconnect() and evictInstance(for:).",
  featureKeys: ["Messaging.messaging", "Messaging.evictInstance", "Messaging.disconnect"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
