import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'Transaction.setData(_:forDocument:merge:)',
  behavior: 'Stages transactional set merge mutation.',
  featureKeys: ['transactionSetDataMerge'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
