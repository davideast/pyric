import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'Transaction.setData(_:forDocument:)',
  behavior: 'Stages transactional set overwrite mutation.',
  featureKeys: ['transactionSetData'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
