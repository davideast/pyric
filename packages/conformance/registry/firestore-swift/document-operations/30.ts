import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 90,
  api: 'DocumentReference.updateData(_:)',
  behavior: 'Updates specified fields in an existing document; fails if document does not exist.',
  featureKeys: ['updateData'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
