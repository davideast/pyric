import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["send", "AndroidConfig"],
  api: 'Offline store-and-forward delivery -- TTL and collapse-key semantics',
  behavior:
    'When a target device is offline FCM stores the message and delivers it on reconnect, up to its time-to-live (`android.ttl`, APNs expiration, webpush `headers.TTL`; the legacy default is 2419200 seconds / four weeks). A collapse key (`android.collapseKey`, `collapseKey`) marks a message as collapsible so a newer collapsible message replaces an older still-undelivered one, and only the last is delivered on reconnect; a message whose TTL elapses before reconnect is dropped rather than delivered. Stated from FCM message-lifecycle documentation; no committed observation replays store-and-forward, collapse, or TTL expiry yet.',
  evidence:
    'Upstream FCM message-lifecycle documentation (TTL, collapse keys, store-and-forward); no committed observation yet. Capturing live offline-to-online push delivery requires the headed `human-witnessed` `messaging-web` browser rig with a persistent Chrome profile and GCM channel.',
  riskReasons: [
    'Store-and-forward queuing, collapse-key replacement, and TTL expiry-drop have no committed production observation, and `MessagingBroker.send()` currently routes accepted messages immediately at send time without an offline queue.',
  ],
  notes:
    'Remains `unverified`: `MessagingBroker` delivers synchronously to active recipients at `send()` time without offline buffering, `collapseKey` replacement, or TTL expiry queuing, and live push capture requires the headed `messaging-web` (`human-witnessed`) rig.',
});
