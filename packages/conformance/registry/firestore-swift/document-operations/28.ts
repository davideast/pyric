import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentReference.setData(_:merge:)',
  behavior: 'Merges payload fields into existing document without overwriting unspecified fields.',
  featureKeys: ['setDataMerge'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
