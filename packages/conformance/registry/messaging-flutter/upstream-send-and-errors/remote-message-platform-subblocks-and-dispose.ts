import { row } from './section.ts';

export default row({
  order: 30,
  api: "RemoteMessage / RemoteNotification / AndroidNotification / AppleNotification / WebNotification / dispose()",
  behavior: "Round-trips full RemoteMessage wire maps including AndroidNotification, AppleNotification, and WebNotification sub-blocks, and rejects post-dispose operations with FirebaseException(code: 'disposed').",
  featureKeys: ["RemoteMessage", "RemoteNotification", "AndroidNotification", "AppleNotification", "WebNotification", "FirebaseMessaging.dispose"],
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` (`round-trips full RemoteMessage, platform sub-blocks, and flat DeliveredPayload image`).",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
  ],
});
