import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["getToken"],
  flipped: 'unit-backed',
  api: 'interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? }',
  behavior:
    'Options for `getToken`: an optional `vapidKey` (Web Push certificate public key) and an optional `serviceWorkerRegistration`.',
  evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
});
