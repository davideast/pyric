import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["BaseMessage"],
  flipped: 'oracle-backed',
  api: 'interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? }',
  behavior:
    'Common message fields shared by every target variant. Production accepts a message carrying ONLY a `notification` block and, separately, ONLY a `data` block — neither is individually required.',
  evidence: 'oracle: `messaging-send-notification-only-vs-data-only-accepted.json` (both accepted). Replayed by the conformance suite.',
  observations: ['messaging-send-notification-only-vs-data-only-accepted'],
});
