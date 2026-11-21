import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseMessaging.getInstance() / getInstance(app) / Firebase.messaging / FirebaseMessaging.close()",
  behavior: "Caches per-FirebaseApp FirebaseMessaging singletons, exposes Firebase.messaging and Firebase.messaging(app) KTX extensions, and tears down active WebSocket streams and cached instances on close().",
  featureKeys: ["FirebaseMessaging.getInstance", "Firebase.messaging", "FirebaseMessaging.close"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`singleton KTX token deduplication caching deleteToken and settings match upstream`) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
