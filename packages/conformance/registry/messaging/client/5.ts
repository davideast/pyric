import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["isSupported"],
  flipped: 'unit-backed',
  api: 'isSupported(): Promise<boolean>',
  behavior:
    'Resolves whether every API required by FCM exists in the current browser window context (bound to `isWindowSupported`).',
  evidence: 'Upstream typings/JSDoc (`@firebase/messaging` 0.12.26); no observation yet.',
});
