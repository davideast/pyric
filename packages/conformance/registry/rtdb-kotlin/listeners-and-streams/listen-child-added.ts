import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.childEvents / onChildAdded',
  behavior: 'Emits ChildEvent.Added for each existing child and whenever a new child is added.',
  featureKeys: ['onChildAdded'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
