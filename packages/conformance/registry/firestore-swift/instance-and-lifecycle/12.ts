import { row } from './section.ts';

export default row({
  order: 120,
  api: 'Firestore.runTransaction(options:block:)',
  behavior: 'Executes an interactive transaction with custom TransactionOptions.',
  featureKeys: ['runTransactionWithOptions'],
  flipped: 'unit-backed',
});
