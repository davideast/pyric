import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["FirebaseMessagingError"],
  flipped: 'oracle-backed',
  api: 'class FirebaseMessagingError extends PrefixedFirebaseError',
  behavior: 'The exported admin messaging error type.',
  evidence: 'oracle: `messaging-send-sendeach-mixed-batch.json` + `messaging-send-sendeach-validation-guards.json` (thrown and per-item rejections are `FirebaseMessagingError` instances with `messaging/*` codes). Replayed by the conformance suite.',
  observations: ['messaging-send-sendeach-mixed-batch', 'messaging-send-sendeach-validation-guards'],
});
