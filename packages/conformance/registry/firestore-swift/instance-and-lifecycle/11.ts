import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 110,
  api: 'Firestore.runTransaction(_:)',
  behavior: 'Executes an interactive transaction block with automatic conflict retry.',
  featureKeys: ['runTransaction'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
