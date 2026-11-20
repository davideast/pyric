import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseQuery.observe(.childChanged) / childEvents',
  behavior: 'Emits childChanged event whenever an existing child node is modified.',
  featureKeys: ['observeChildChanged'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
