import { row } from './section.ts';

export default row({
  order: 110,
  api: 'FirebaseFirestore.terminate()',
  behavior: 'Terminates the Firestore client, closing network connections and unsubscribing active snapshot flows.',
  featureKeys: ['terminate'],
  flipped: 'unit-backed',
});
