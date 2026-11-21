import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "token() / fcmToken / MessagingDelegate.messaging(_:didReceiveRegistrationToken:) / MessagingRegistrationTokenRefreshed",
  behavior: "Mints a deterministic 142-character :APA91b FCM token, coalesces concurrent token() requests, caches fcmToken across repeat calls, and notifies MessagingDelegate and NotificationCenter (.MessagingRegistrationTokenRefreshed) whenever a token is minted or rotated.",
  featureKeys: ["Messaging.token", "Messaging.fcmToken", "MessagingDelegate", "Notification.Name.MessagingRegistrationTokenRefreshed"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
