import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 210,
  api: 'Firestore.getQuery(named:completion:)',
  behavior: 'Retrieves a named query from a previously loaded Firestore bundle.',
  featureKeys: ['getQuery'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
