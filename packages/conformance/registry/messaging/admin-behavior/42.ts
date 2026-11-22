import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["send", "AndroidConfig"],
  api: 'Offline store-and-forward delivery -- TTL and collapse-key semantics',
  behavior:
    'When a target device is offline FCM stores the message and delivers it on reconnect, up to its time-to-live (`android.ttl`, APNs expiration, webpush `headers.TTL`; the legacy default is 2419200 seconds / four weeks). A collapse key (`android.collapseKey`, `collapseKey`) marks a message as collapsible so a newer collapsible message replaces an older still-undelivered one, and only the last is delivered on reconnect; a message whose TTL elapses before reconnect is dropped rather than delivered. Stated from FCM message-lifecycle documentation; no committed observation replays store-and-forward, collapse, or TTL expiry yet.',
  evidence:
    'Staged `messaging-send` probe `packages/conformance/probes/messaging-admin/messaging-send-ttl-and-collapse-key.ts` (`pendingRowLink: true`) for send-plane TTL/collapse-key bounds, plus headed `messaging-web` scenario `offline-store-and-forward` (`packages/conformance/src/capture/messaging-web/offline-store-and-forward-scenario.ts`) for live offline reconnect buffering, `Topic`/`collapseKey` replacement, and short-TTL expiry drop; awaiting observation capture.',
  riskReasons: [
    'Send-plane probe `messaging-send-ttl-and-collapse-key` (`pendingRowLink: true`) and headed `messaging-web` scenario `messaging-web-offline-store-and-forward` do not have committed observation files yet, and `MessagingBroker.send()` routes accepted messages synchronously at send time without an offline queue.',
  ],
  notes:
    'Staged across `messaging-send` (automated on `main` for `messaging-send-ttl-and-collapse-key.json`) and `messaging-web` (`--write --only offline-store-and-forward`, `human-witnessed`, for `messaging-web-offline-store-and-forward.json`); remains `unverified` until captured.',
});
