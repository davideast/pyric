import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getMessaging', 'messaging'],
  flipped: 'oracle-backed',
  api: 'messaging(app?): removed in firebase-admin v14',
  behavior:
    'Legacy v8 `admin.messaging(app?)` / `messaging(app?)` entry was removed upstream in `firebase-admin` v14; `pyric-admin/messaging` and root `pyric-admin` omit it and expose modular `getMessaging(app?)` exclusively.',
  evidence:
    'oracle: `messaging-send-admin-entry-accessors.json` + `admin-surface.test.ts` (`firebase-admin` 14.5.1 exports only `getMessaging`, `Messaging`, `FirebaseMessagingError`, and `MessagingErrorCode`). Replayed by the conformance suite.',
  observations: ['messaging-send-admin-entry-accessors'],
});
