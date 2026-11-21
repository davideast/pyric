import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseMessaging.useMessagingEmulator(host, port)",
  behavior: "Connects a dedicated PyricBridgeClient to ws://<host>:<port> (normalizing wildcard 0.0.0.0 and :: bind addresses to 127.0.0.1) and activates live foreground and background subscriptions.",
  featureKeys: ["FirebaseMessaging.useMessagingEmulator"],
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart`.",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
  ],
});
