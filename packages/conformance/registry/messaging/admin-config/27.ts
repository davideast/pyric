import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["AndroidConfig"],
  flipped: 'oracle-backed',
  api: 'interface AndroidConfig { collapseKey?; priority?; ttl?; restrictedPackageName?; data?; notification?; fcmOptions?; ... }',
  behavior: 'Android overrides; `ttl` is in milliseconds and `priority` is `high` | `normal`.',
  evidence: 'oracle: `messaging-send-android-config.json` (`collapseKey`, `priority`, `ttl`, `data`, `directBootOk` accepted; negative `ttl` and non-string `android.data` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-android-config'],
});
