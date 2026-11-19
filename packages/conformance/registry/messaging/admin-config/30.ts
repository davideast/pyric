import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["AndroidFcmOptions"],
  flipped: 'oracle-backed',
  api: 'interface AndroidFcmOptions { analyticsLabel? }',
  behavior: 'Android FCM options (`analyticsLabel`).',
  evidence: 'oracle: `messaging-send-android-fcm-options.json` (`analyticsLabel` accepted; non-string rejected in preflight; >50-char label rejected on FCM v1 wire with HTTP 400 INVALID_ARGUMENT). Replayed by the conformance suite.',
  observations: ['messaging-send-android-fcm-options'],
});
