import { row } from './section.ts';

export default row({
  order: 40,
  api: "requestPermission(...) / getNotificationSettings() / setForegroundNotificationPresentationOptions(...) / setAutoInitEnabled / setDeliveryMetricsExportToBigQuery / getAPNSToken / isSupported",
  behavior: "Resolves NotificationSettings (AuthorizationStatus.authorized, provisional, denied, notDetermined), persists foreground presentation options, auto-init, BigQuery export, and APNs token state, and reports runtime support via isSupported().",
  featureKeys: ["FirebaseMessaging.requestPermission", "FirebaseMessaging.getNotificationSettings", "FirebaseMessaging.setForegroundNotificationPresentationOptions", "FirebaseMessaging.setAutoInitEnabled", "FirebaseMessaging.setDeliveryMetricsExportToBigQuery", "FirebaseMessaging.getAPNSToken", "FirebaseMessaging.isSupported"],
  evidence: "Verified in `packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart` (`round-trips NotificationSettings and permission state transitions`).",
  tests: [
    "packages/flutter-client/test/messaging/firebase_messaging_unit_test.dart",
  ],
});
