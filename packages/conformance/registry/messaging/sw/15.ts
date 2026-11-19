import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["experimentalSetDeliveryMetricsExportedToBigQueryEnabled"],
  flipped: 'oracle-backed',
  api: 'experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void',
  behavior: 'Enables or disables delivery-metrics export to BigQuery at runtime; default off.',
  evidence: 'oracle: `messaging-web-sw-delivery-metrics-toggle.json` (`undefined` return, continued `onBackgroundMessage` delivery across enabled/disabled states, and sync `null`-handle rejection). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-sw-delivery-metrics-toggle'],
  tests: ['packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
});
