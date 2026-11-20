import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.instanceFor(app: app)',
  behavior: 'Returns a platform instance associated with a specific FirebaseApp.',
  featureKeys: ['instanceFor'],
  flipped: 'unit-backed',
});
