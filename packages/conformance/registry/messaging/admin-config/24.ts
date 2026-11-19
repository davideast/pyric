import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["ApsAlert"],
  flipped: 'oracle-backed',
  api: 'interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; ...; launchImage? }',
  behavior: 'APNs alert object with title/subtitle/body and localization keys.',
  evidence: 'oracle: `messaging-send-apns-aps-alert.json` (`ApsAlert` fields accepted; `*LocArgs` without matching `*LocKey` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-aps-alert'],
});
