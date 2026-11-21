import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseMessaging.deleteToken()",
  behavior: "Revokes the active FCM registration token on MessagingBroker so targeted admin sends fail with messaging/registration-token-not-registered and subsequent token requests mint a fresh distinct 142-character token.",
  featureKeys: ["FirebaseMessaging.deleteToken"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
