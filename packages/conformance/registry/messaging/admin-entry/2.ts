import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getMessaging","messaging"],
  flipped: 'oracle-backed',
  api: 'messaging(app?): messaging.Messaging',
  behavior:
    'Namespaced / legacy accessor equivalent of `getMessaging`, exposed by the compat entry alongside the `namespace messaging` type aliases.',
  evidence: 'oracle: `messaging-send-admin-entry-accessors.json` (`admin.messaging(app?)` returns the same cached per-app `Messaging` instance as `getMessaging(app?)`). Replayed by the conformance suite.',
  observations: ['messaging-send-admin-entry-accessors'],
});
