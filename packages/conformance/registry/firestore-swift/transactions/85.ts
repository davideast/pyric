import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'Transaction.getDocument(_:)',
  behavior: 'Reads document snapshot within transaction and establishes read lock.',
  featureKeys: ['transactionGetDocument'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
