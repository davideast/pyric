import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseMessaging local Pyric WebSocket bridge transport",
  behavior: "Routes FCM token minting, topic operations, visibility transitions, upstream send(), and delivery streams over the local Pyric WebSocket bridge (/__pyric/sandbox) instead of Google Play Services and Android OS FCM binder IPC.",
  featureKeys: ["FirebaseMessaging.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of binding to Google Play Services or cloud FCM endpoints, `FirebaseMessaging` dispatches `messaging.*` `worker-op` and `worker-sub` frames over `/__pyric/sandbox` to `MessagingBroker`. Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
