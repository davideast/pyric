import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'WriteBatch.setData(_:forDocument:merge:)',
  behavior: 'Enqueues set merge operation into atomic mutation batch.',
  featureKeys: ['batchSetDataMerge'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
