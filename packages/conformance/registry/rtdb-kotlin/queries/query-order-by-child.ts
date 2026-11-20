import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.orderByChild(path)',
  behavior: 'Orders query results by the value of the specified nested child key.',
  featureKeys: ['orderByChild'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
