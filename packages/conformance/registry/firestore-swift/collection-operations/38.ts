import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'CollectionReference.document()',
  behavior: 'Instantiates a child DocumentReference with an auto-generated unique ID.',
  featureKeys: ['documentAutoId'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
