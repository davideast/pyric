import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'WriteBatch.setData(_:forDocument:mergeFields:)',
  behavior: 'Enqueues selective field merge operation into atomic mutation batch.',
  featureKeys: ['batchSetDataMergeFields'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
