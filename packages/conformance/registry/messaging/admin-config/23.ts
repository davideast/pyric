import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["Aps"],
  flipped: 'oracle-backed',
  api: 'interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] }',
  behavior: 'APNs `aps` dictionary; `alert` is a string or an `ApsAlert`, `sound` a string or a `CriticalSound`.',
  evidence: 'oracle: `messaging-send-apns-aps-fields.json` (camelCase `contentAvailable`, `mutableContent`, `threadId` accepted; duplicate camelCase/hyphenated keys rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-apns-aps-fields'],
});
