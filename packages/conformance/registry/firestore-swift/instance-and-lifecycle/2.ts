import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Firestore.firestore(app:)',
  behavior: 'Returns a Firestore instance associated with the specified FirebaseApp.',
  featureKeys: ['firestoreApp'],
  flipped: 'unit-backed',
});
