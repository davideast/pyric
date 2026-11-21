import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "getInitialMessage() / FirebaseMessaging.onMessageOpenedApp / simulateNotificationOpen(message, {asInitialMessage})",
  behavior: "Delivers cold-start notification taps once via getInitialMessage() (clearing the buffered message afterward) and emits warm-resume notification taps on FirebaseMessaging.onMessageOpenedApp.",
  featureKeys: ["FirebaseMessaging.getInitialMessage", "FirebaseMessaging.onMessageOpenedApp", "FirebaseMessaging.simulateNotificationOpen"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
