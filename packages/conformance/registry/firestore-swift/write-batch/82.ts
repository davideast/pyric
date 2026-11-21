import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'WriteBatch.updateData(_:forDocument:)',
  behavior: 'Enqueues update operation into atomic mutation batch.',
  featureKeys: ['batchUpdateData'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
