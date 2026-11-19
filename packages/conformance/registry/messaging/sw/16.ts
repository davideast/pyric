import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["isSupported"],
  flipped: 'unit-backed',
  api: 'isSupported(): Promise<boolean> (sw)',
  behavior:
    'Resolves whether every API required by FCM exists within the service-worker context (bound to `isSwSupported`).',
  evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
});
