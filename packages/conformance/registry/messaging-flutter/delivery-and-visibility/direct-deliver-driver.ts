import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "deliver({data, notification, visibilityState, from, messageId}) / MessagingDeliveryResult",
  behavior: "Injects synthetic foreground or background RemoteMessage deliveries through messaging.deliver and returns MessagingDeliveryResult route and handlerCount metadata.",
  featureKeys: ["FirebaseMessaging.deliver", "MessagingDeliveryResult"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
