import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "subscribeToTopic(topic) / unsubscribeFromTopic(topic) / TopicOperation",
  behavior: "Strips an optional /topics/ prefix, rejects empty or malformed topic names locally with IllegalArgumentException before any bridge op, and binds or unbinds the client token on MessagingBroker.",
  featureKeys: ["FirebaseMessaging.subscribeToTopic", "FirebaseMessaging.unsubscribeFromTopic", "TopicOperation"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`topic validation strips prefix rejects malformed names locally and checks broker outcome`) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
