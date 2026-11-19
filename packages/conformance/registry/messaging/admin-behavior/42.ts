import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["send", "AndroidConfig"],
  api: 'Offline store-and-forward delivery — TTL and collapse-key semantics',
  behavior:
    'When a target device is offline FCM stores the message and delivers it on reconnect, up to its time-to-live (`android.ttl`, APNs expiration, webpush `headers.TTL`; the legacy default is 2419200 seconds / four weeks). A collapse key (`android.collapseKey`, `collapseKey`) marks a message as collapsible so a newer collapsible message replaces an older still-undelivered one, and only the last is delivered on reconnect; a message whose TTL elapses before reconnect is dropped rather than delivered. Stated from FCM message-lifecycle documentation; no committed observation replays store-and-forward, collapse, or TTL expiry yet.',
  evidence:
    'Upstream documentation (FCM message lifecycle: TTL, collapse keys, store-and-forward); no observation yet. Candidate probe: send several collapsible messages to a token whose web client is offline, bring it online within TTL, and assert only the last collapsible message is delivered; separately, let a short-TTL message expire before reconnect and assert it is dropped.',
  riskReasons: [
    'Store-and-forward queuing, collapse-key replacement, and TTL expiry-drop stated from FCM lifecycle documentation only; no committed observation replays offline delivery — a probe candidate before implementation.',
  ],
  notes:
    'Candidate capture for the re-capture lane (#444): an offline-then-reconnect web client asserting collapse-key last-write-wins delivery and TTL expiry drop.',
});
