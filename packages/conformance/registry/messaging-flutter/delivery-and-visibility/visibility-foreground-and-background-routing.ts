import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "setVisibility(state) / FirebaseMessaging.onMessage / onForegroundMessage / FirebaseMessaging.onBackgroundMessage / onInstanceBackgroundMessage",
  behavior: "Synchronizes 'visible' and 'hidden' client visibility with MessagingBroker and routes decoded RemoteMessage payloads (from, data, RemoteNotification, WebNotification image) exclusively to foreground streams or background handlers.",
  featureKeys: ["FirebaseMessaging.setVisibility", "FirebaseMessaging.onMessage", "FirebaseMessaging.onForegroundMessage", "FirebaseMessaging.onBackgroundMessage", "FirebaseMessaging.onInstanceBackgroundMessage"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
