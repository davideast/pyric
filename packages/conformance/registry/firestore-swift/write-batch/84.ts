import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'WriteBatch.commit()',
  behavior: 'Atomically commits all enqueued batch mutations in a single transaction.',
  featureKeys: ['batchCommit'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
