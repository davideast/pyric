import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseFirestore.runTransaction(handler)',
  behavior: 'Runs interactive transaction handler with automatic conflict retries up to TransactionOptions.maxAttempts.',
  featureKeys: ['runTransaction'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
