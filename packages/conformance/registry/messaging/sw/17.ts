import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["getMessaging","onBackgroundMessage","experimentalSetDeliveryMetricsExportedToBigQueryEnabled","isSupported","Messaging"],
  flipped: 'oracle-backed',
  api: 'firebase/messaging/sw module boundary + shared type parity',
  behavior:
    'The sw entry exports `onBackgroundMessage`, `getMessaging`, `experimentalSetDeliveryMetricsExportedToBigQueryEnabled`, and `isSupported`, but NOT `getToken` / `deleteToken` / `onMessage`; the client entry exports the latter but NOT `onBackgroundMessage` / the metrics toggle. The two modules register under different component names (`messaging` vs `messaging-sw`) and re-export identical `Messaging` / `GetTokenOptions` / `MessagePayload` / `NotificationPayload` / `FcmOptions` type declarations.',
  evidence: 'oracle: `messaging-web-module-boundary-and-accessors.json` (symmetric client vs sw export matrix and distinct `messaging` vs `messaging-sw` component instances). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-module-boundary-and-accessors'],
  tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts', 'packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
});
