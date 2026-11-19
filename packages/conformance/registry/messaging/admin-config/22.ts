import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["ApnsPayload"],
  flipped: 'oracle-backed',
  api: 'interface ApnsPayload { aps; [customData] }',
  behavior: 'APNs payload wrapper carrying the required `aps` dictionary plus arbitrary custom keys.',
  evidence: 'oracle: `messaging-send-apns-payload-custom-data.json` (`aps` + custom top-level keys accepted; non-object `apns.payload` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-payload-custom-data'],
});
