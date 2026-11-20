import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.whereField(_:isGreaterThanOrEqualTo:)',
  behavior: 'Filters documents where field is greater than or equal to value.',
  featureKeys: ['whereFieldGreaterThanOrEqualTo'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
