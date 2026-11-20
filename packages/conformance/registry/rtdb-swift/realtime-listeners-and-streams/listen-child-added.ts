import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseQuery.observe(.childAdded) / childEvents',
  behavior: 'Emits childAdded event for each existing child and whenever a new child is added.',
  featureKeys: ['observeChildAdded'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
