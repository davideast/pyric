import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Transaction.update(documentReference, data)',
  behavior: 'Enqueues transactional update mutation to be committed on handler completion.',
  featureKeys: ['update', 'transaction'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
