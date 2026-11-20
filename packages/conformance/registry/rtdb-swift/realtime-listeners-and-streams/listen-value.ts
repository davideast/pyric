import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseQuery.observe(.value) / valueStream',
  behavior: 'Emits DataSnapshot initially and upon any data change at the path via AsyncStream or observer.',
  featureKeys: ['observeValue', 'valueStream'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
