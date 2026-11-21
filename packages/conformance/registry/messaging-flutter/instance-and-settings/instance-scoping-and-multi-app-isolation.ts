import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseMessaging.instance / FirebaseMessaging.instanceFor({app}) / registerWith / clearInstancesForTest",
  behavior: "Caches per-FirebaseApp FirebaseMessaging instances with isolated registration tokens and delivery streams across default and named apps, and resets instances via clearInstancesForTest().",
  featureKeys: ["FirebaseMessaging.instance", "FirebaseMessaging.instanceFor", "FirebaseMessaging.registerWith", "FirebaseMessaging.clearInstancesForTest"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
