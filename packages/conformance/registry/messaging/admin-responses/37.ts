import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["SendResponse"],
  flipped: 'oracle-backed',
  api: 'interface SendResponse { success; messageId?; error? }',
  behavior: 'Per-message batch entry - on success `messageId` is set, on failure `error` is set.',
  evidence: 'oracle: `messaging-send-sendeach-mixed-batch.json` + `messaging-send-multicast-batch.json` (per-item `success`, `messageId` resource name, and `FirebaseMessagingError`). Replayed by the conformance suite.',
  observations: ['messaging-send-sendeach-mixed-batch', 'messaging-send-multicast-batch'],
});
