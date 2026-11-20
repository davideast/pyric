import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseQuery.queryOrderedByKey()',
  behavior: 'Orders query results lexicographically by child key name.',
  featureKeys: ['queryOrderedByKey'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
