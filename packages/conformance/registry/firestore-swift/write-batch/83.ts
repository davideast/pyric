import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'WriteBatch.deleteDocument(_:)',
  behavior: 'Enqueues document deletion into atomic mutation batch.',
  featureKeys: ['batchDeleteDocument'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
