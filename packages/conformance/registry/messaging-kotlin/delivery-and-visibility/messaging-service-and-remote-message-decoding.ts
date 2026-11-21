import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "registerService / unregisterService / FirebaseMessagingService.onMessageReceived / RemoteMessage / RemoteMessage.Notification",
  behavior: "Dispatches decoded RemoteMessage payloads (messageId, from, collapseKey, data map, priority, ttl, and Notification title/body/imageUrl/channelId/clickAction) to registered FirebaseMessagingService listeners across both admin sends and direct messaging.deliver injections.",
  featureKeys: ["FirebaseMessaging.registerService", "FirebaseMessaging.unregisterService", "FirebaseMessagingService.onMessageReceived", "RemoteMessage", "RemoteMessage.Notification"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
