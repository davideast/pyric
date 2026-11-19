import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["Messaging"],
  flipped: 'unit-backed',
  api: 'interface Messaging { app }',
  behavior: 'Public interface of the FCM client SDK; exposes the bound `FirebaseApp` as `app`.',
  evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
});
