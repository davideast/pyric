import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DataSnapshot.children',
  behavior: 'Returns an iterator of child DataSnapshots ordered according to the active query.',
  featureKeys: ['children'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
