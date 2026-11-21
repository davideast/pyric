import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseMessaging.token / FirebaseMessagingService.onNewToken(token) / newTokenFlow",
  behavior: "Mints a deterministic 142-character :APA91b FCM registration token, coalesces concurrent getToken() calls, returns identical cached tokens on repeat calls, and emits initial and rotated tokens to FirebaseMessagingService.onNewToken and newTokenFlow.",
  featureKeys: ["FirebaseMessaging.token", "FirebaseMessagingService.onNewToken", "FirebaseMessaging.newTokenFlow"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
