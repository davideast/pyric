import { row } from './section.ts';

export default row({
  order: 75,
  featureKeys: ['RegisterOptions'],
  flipped: 'type-backed',
  exceptionReason:
    'Type-only option shape closed structurally by strict tsc Exact<RegisterOptions, UpstreamRegisterOptions> parity in packages/pyric/test/messaging/types.test.ts and the public surface census.',
  api: 'interface RegisterOptions { vapidKey?; serviceWorkerRegistration? }',
  behavior:
    'Options for `register`: an optional `vapidKey` (Web Push certificate public key) and an optional `serviceWorkerRegistration` scoping FID registration.',
  evidence:
    'Upstream typings (`@firebase/messaging` 0.13.3 `public-types`); unit-tested via sandbox registration handles across `pyric/messaging` and `pyric/messaging/sw`.',
  tests: ['packages/pyric/test/messaging/registration.test.ts'],
});
