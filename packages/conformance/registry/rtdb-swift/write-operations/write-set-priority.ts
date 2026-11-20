import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseReference.setPriority(_:)',
  behavior: 'Updates the ordering priority metadata of the node without altering its value.',
  featureKeys: ['setPriority'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
