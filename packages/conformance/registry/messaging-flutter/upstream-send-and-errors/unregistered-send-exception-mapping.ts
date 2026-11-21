import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseMessagingSendException (code: 'unregistered', status: 'NOT_FOUND')",
  behavior: "Maps revoked-token and unregistered-recipient broker rejections to FirebaseMessagingSendException with plugin: 'firebase_messaging', code: 'unregistered', and status: 'NOT_FOUND'.",
  featureKeys: ["FirebaseMessagingSendException"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` and `packages/flutter-client/test/live_host/messaging_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
    "packages/flutter-client/test/live_host/messaging_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
