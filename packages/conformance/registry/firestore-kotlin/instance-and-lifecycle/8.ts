import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseFirestore.runTransaction(handler)',
  behavior: 'Runs interactive transaction handler with automatic conflict retries up to TransactionOptions.maxAttempts.',
  featureKeys: ['runTransaction'],
  flipped: 'unit-backed',
});
