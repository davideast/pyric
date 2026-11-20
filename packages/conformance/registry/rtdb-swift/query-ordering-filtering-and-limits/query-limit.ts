import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseQuery.queryLimited(toFirst:) / queryLimited(toLast:)',
  behavior: 'Caps query results to the first N or last N ordered child nodes.',
  featureKeys: ['queryLimitedToFirst', 'queryLimitedToLast'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
