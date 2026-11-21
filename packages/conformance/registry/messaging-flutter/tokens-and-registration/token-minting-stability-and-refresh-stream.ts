import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "getToken({vapidKey}) / onTokenRefresh",
  behavior: "Mints a deterministic 142-character :APA91b FCM token over messaging.getToken, returns identical cached tokens across repeat calls, and emits on onTokenRefresh only when a token is newly minted or rotated.",
  featureKeys: ["FirebaseMessaging.getToken", "FirebaseMessaging.onTokenRefresh"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
