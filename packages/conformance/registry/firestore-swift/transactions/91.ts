import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 70,
  api: 'TransactionOptions.maxAttempts',
  behavior: 'Configures maximum retry attempts upon transactional concurrent contention.',
  featureKeys: ['transactionOptionsMaxAttempts'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
