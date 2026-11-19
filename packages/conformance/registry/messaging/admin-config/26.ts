import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["ApnsFcmOptions"],
  flipped: 'oracle-backed',
  api: 'interface ApnsFcmOptions { analyticsLabel?; imageUrl? }',
  behavior: 'APNs FCM options (`analyticsLabel`, `imageUrl`).',
  evidence: 'oracle: `messaging-send-apns-fcm-options.json` (`analyticsLabel` + `imageUrl` accepted; invalid URL or duplicate `image`/`imageUrl` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-fcm-options'],
});
