import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "sendBrokerMessage(message, {validateOnly}) / AcceptedMessagingSend",
  behavior: "Sends direct-token, topic, and boolean-condition ('breaking_news' in topics && 'vip_tier' in topics) outbound payloads through MessagingBroker and decodes AcceptedMessagingSend identifiers.",
  featureKeys: ["FirebaseMessaging.sendBrokerMessage", "AcceptedMessagingSend"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
