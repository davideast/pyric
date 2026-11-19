import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["AndroidNotification"],
  flipped: 'oracle-backed',
  api: 'interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; channelId?; priority?; visibility?; lightSettings?; ... }',
  behavior: 'Android notification options, including localization keys, LED light settings, and delivery-proxy controls.',
  evidence: 'oracle: `messaging-send-android-notification.json` (`#RRGGBB` color, `Date` `eventTimestamp`, `vibrateTimingsMillis`, localization keys accepted; malformed color, missing `bodyLocKey`, non-`Date` timestamp rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-android-notification'],
});
