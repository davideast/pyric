import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "setVisibility(visible: Boolean) / setVisibility(state: String) / foregroundMessages / backgroundMessages",
  behavior: "Synchronizes client visibility state ('visible' or 'hidden') with MessagingBroker so broker deliveries route exclusively to foregroundMessages while visible and backgroundMessages while hidden.",
  featureKeys: ["FirebaseMessaging.setVisibility", "FirebaseMessaging.foregroundMessages", "FirebaseMessaging.backgroundMessages"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
