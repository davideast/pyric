import { row } from './section.ts';

export default row({
  order: 130,
  api: 'Firestore.runTransaction(_:) async',
  behavior: 'Executes an interactive transaction asynchronously via Swift concurrency.',
  featureKeys: ['runTransactionAsync'],
  flipped: 'unit-backed',
});
