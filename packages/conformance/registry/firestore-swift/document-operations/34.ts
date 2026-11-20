import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 130,
  api: 'DocumentReference.addSnapshotListener(options:listener:)',
  behavior: 'Listens to document updates configured with SnapshotListenOptions.',
  featureKeys: ['addSnapshotListenerOptions'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
