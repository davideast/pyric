import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Notification"],
  flipped: 'oracle-backed',
  api: 'interface Notification { title?; body?; imageUrl? }',
  behavior: 'Top-level, platform-independent notification block. Production accepts a notification-only message (no data block).',
  evidence: 'oracle: `messaging-send-notification-only-vs-data-only-accepted.json`. Replayed by the conformance suite.',
  observations: ['messaging-send-notification-only-vs-data-only-accepted'],
});
