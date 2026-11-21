import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "subscribeToTopic(topic) / unsubscribeFromTopic(topic) / validateAndNormalizeTopic(topic)",
  behavior: "Strips an optional /topics/ prefix, validates [a-zA-Z0-9-_.~%]+ topic syntax locally before dispatching bridge operations, and binds or unbinds the client token on MessagingBroker.",
  featureKeys: ["FirebaseMessaging.subscribeToTopic", "FirebaseMessaging.unsubscribeFromTopic", "validateAndNormalizeTopic"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
