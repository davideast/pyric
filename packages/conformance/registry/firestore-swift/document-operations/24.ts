import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentReference.parent',
  behavior: 'Returns the parent CollectionReference containing this document.',
  featureKeys: ['parent'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
