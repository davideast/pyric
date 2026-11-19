import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["WebpushFcmOptions"],
  flipped: 'oracle-backed',
  api: 'interface WebpushFcmOptions { link? }',
  behavior: 'Webpush FCM options (`link`, HTTPS required). Production accepts `fcmOptions.link` on a webpush send.',
  evidence: 'oracle: `messaging-send-webpush-config-accepted.json` (link accepted). Replayed by the conformance suite.',
  observations: ['messaging-send-webpush-config-accepted'],
});
