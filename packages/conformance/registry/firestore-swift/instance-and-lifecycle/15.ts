import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_LIFECYCLE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 150,
  api: 'Firestore.enableNetwork() / disableNetwork()',
  behavior: 'Toggles client network connectivity to simulate offline and online operation.',
  featureKeys: ['enableNetwork', 'disableNetwork'],
  status: 'conforms',
  tests: [LIVE_HOST_LIFECYCLE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
