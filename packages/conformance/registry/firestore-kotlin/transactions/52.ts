import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Transaction.delete(documentReference)',
  behavior: 'Enqueues transactional delete mutation to be committed on handler completion.',
  featureKeys: ['delete', 'transaction'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
