import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["ApnsConfig"],
  flipped: 'oracle-backed',
  api: 'interface ApnsConfig { liveActivityToken?; headers?; payload?; fcmOptions? }',
  behavior: 'APNs overrides.',
  evidence: 'oracle: `messaging-send-apns-config-and-headers.json` (`apns.headers` + `apns.payload` accepted; empty `liveActivityToken` and non-string header values rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-config-and-headers'],
});
