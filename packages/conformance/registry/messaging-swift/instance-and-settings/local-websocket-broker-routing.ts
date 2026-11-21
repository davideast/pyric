import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Messaging local Pyric WebSocket bridge transport",
  behavior: "Routes FCM token minting, topic operations, visibility transitions, sendBrokerMessage(), and delivery streams over the local Pyric WebSocket bridge via app.useEmulator(withHost:port:) instead of Apple APNs daemon IPC and cloud FCM endpoints.",
  featureKeys: ["Messaging.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of registering with Apple Push Notification service (`apsd`) and cloud FCM endpoints, `PyricMessaging` dispatches `messaging.*` `worker-op` and `worker-sub` frames over the local Pyric WebSocket bridge to `MessagingBroker`. Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
