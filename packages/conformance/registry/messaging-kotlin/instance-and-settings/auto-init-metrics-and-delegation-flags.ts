import { row } from './section.ts';

export default row({
  order: 30,
  api: "isAutoInitEnabled / deliveryMetricsExportToBigQueryEnabled() / setDeliveryMetricsExportToBigQuery(enable) / isNotificationDelegationEnabled / setNotificationDelegationEnabled(enable)",
  behavior: "Persists local auto-init, BigQuery delivery metrics export, and Android notification delegation flags with Task<Void> completion on setNotificationDelegationEnabled.",
  featureKeys: ["FirebaseMessaging.isAutoInitEnabled", "FirebaseMessaging.deliveryMetricsExportToBigQueryEnabled", "FirebaseMessaging.setDeliveryMetricsExportToBigQuery", "FirebaseMessaging.isNotificationDelegationEnabled", "FirebaseMessaging.setNotificationDelegationEnabled"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`singleton KTX token deduplication caching deleteToken and settings match upstream`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
  ],
});
