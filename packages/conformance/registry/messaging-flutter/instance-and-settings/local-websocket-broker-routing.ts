import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseMessaging local Pyric WebSocket bridge transport",
  behavior: "Routes FCM token minting, topic operations, visibility transitions, sendBrokerMessage(), and delivery streams over the local Pyric WebSocket bridge instead of Flutter MethodChannel / EventChannel platform bindings, APNs, or Google Play Services.",
  featureKeys: ["FirebaseMessaging.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of invoking platform channels or cloud FCM endpoints, `pyric_messaging` dispatches `messaging.*` `worker-op` and `worker-sub` frames over `/__pyric/sandbox` to `MessagingBroker`. Verified in `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
