import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFirestore.getInstance() / Firebase.firestore',
  behavior: 'Returns the default FirebaseFirestore instance for the default FirebaseApp.',
  featureKeys: ['getInstance'],
  flipped: 'unit-backed',
});
