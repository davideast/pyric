import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseQuery.observe(.childRemoved) / childEvents',
  behavior: 'Emits childRemoved event whenever a child node is removed from the watched location.',
  featureKeys: ['observeChildRemoved'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
