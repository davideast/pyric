import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseFirestorePlatform.runTransaction(handler, {timeout, maxAttempts})',
  behavior: 'Runs interactive transaction handler with automatic conflict retries.',
  featureKeys: ['runTransaction'],
  flipped: 'unit-backed',
});
