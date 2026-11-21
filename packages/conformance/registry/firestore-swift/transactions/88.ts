import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'Transaction.setData(_:forDocument:mergeFields:)',
  behavior: 'Stages transactional selective field merge mutation.',
  featureKeys: ['transactionSetDataMergeFields'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
