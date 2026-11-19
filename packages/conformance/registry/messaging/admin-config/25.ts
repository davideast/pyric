import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["CriticalSound"],
  flipped: 'oracle-backed',
  api: 'interface CriticalSound { critical?; name; volume? }',
  behavior: 'APNs critical sound - `name` required; `volume` in the range 0.0-1.0.',
  evidence: 'oracle: `messaging-send-apns-critical-sound.json` (`CriticalSound` accepted; empty `name` or `volume` outside `[0, 1]` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-critical-sound'],
});
