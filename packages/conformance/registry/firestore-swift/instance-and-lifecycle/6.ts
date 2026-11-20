import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Firestore.app',
  behavior: 'Returns the FirebaseApp associated with this Firestore instance.',
  featureKeys: ['app'],
  flipped: 'unit-backed',
});
