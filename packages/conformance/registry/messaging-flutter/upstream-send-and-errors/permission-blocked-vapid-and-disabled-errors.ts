import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseException ('permission-blocked', 'invalid-vapid-key', 'disabled')",
  behavior: "Throws typed firebase_messaging FirebaseException errors when notification authorization is denied ('permission-blocked'), an empty vapidKey is supplied ('invalid-vapid-key'), or HostedRuntime omits messaging capability ('disabled').",
  featureKeys: ["FirebaseException.permissionBlocked", "FirebaseException.invalidVapidKey", "FirebaseException.disabled"],
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` (`maps permission-blocked, disabled capability gate, and unregistered send errors to FirebaseException`).",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
  ],
});
