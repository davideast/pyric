import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["FcmOptions"],
  flipped: 'oracle-backed',
  api: 'interface FcmOptions { analyticsLabel? }',
  behavior: 'Platform-independent FCM options (`analyticsLabel`).',
  evidence: 'oracle: `messaging-send-fcm-options-analytics-label.json` (accepted on send/dryRun, non-string rejected with `messaging/invalid-payload`, >50-char top-level wire accepted). Replayed by the conformance suite.',
  observations: ['messaging-send-fcm-options-analytics-label'],
});
