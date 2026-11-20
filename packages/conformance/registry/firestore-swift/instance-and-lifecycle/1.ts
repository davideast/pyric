import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Firestore.firestore()',
  behavior: 'Returns the default Firestore instance configured with the default FirebaseApp.',
  featureKeys: ['firestore'],
  flipped: 'unit-backed',
});
