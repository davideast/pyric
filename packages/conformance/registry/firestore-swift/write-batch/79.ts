import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'WriteBatch.setData(_:forDocument:)',
  behavior: 'Enqueues set overwrite operation into atomic mutation batch.',
  featureKeys: ['batchSetData'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
