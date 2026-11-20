import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Transaction retry mechanism',
  behavior: 'Catches optimistic locking conflicts and re-executes handler up to maxAttempts.',
  featureKeys: ['runTransaction'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
