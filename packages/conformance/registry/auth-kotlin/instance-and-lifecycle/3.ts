import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuth.app',
  behavior: 'Returns the FirebaseApp instance associated with this FirebaseAuth instance.',
  featureKeys: ['app'],
  flipped: 'unit-backed',
});
