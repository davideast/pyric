import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 80,
  api: 'DocumentReference.setData(_:mergeFields:)',
  behavior: 'Replaces only explicitly specified field paths in the target document.',
  featureKeys: ['setDataMergeFields'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
