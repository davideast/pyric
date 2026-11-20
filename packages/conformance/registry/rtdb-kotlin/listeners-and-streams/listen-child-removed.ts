import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.childEvents / onChildRemoved',
  behavior: 'Emits ChildEvent.Removed whenever a child node is removed from the watched location.',
  featureKeys: ['onChildRemoved'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
