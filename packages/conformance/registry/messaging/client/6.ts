import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['Messaging'],
  flipped: 'unit-backed',
  exceptionReason:
    'Browser-bound client handle interface whose getMessaging(app) factory requires browser Service Worker and Notification globals unavailable in headless Node production probes.',
  api: 'interface Messaging { app }',
  behavior: 'Public interface of the FCM client SDK; exposes the bound `FirebaseApp` as `app`.',
  evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); unit-tested against sandbox client handles.',
});
