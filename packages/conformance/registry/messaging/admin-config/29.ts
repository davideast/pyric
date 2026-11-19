import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["LightSettings"],
  flipped: 'oracle-backed',
  api: 'interface LightSettings { color; lightOnDurationMillis; lightOffDurationMillis }',
  behavior: 'Android LED light settings - all three fields required.',
  evidence: 'oracle: `messaging-send-android-light-settings.json` (`#RRGGBB` and `#RRGGBBAA` LED colors with ms durations accepted; negative duration or malformed hex color rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-android-light-settings'],
});
