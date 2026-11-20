import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.whereField(_:isGreaterThan:)',
  behavior: 'Filters documents where field is strictly greater than value.',
  featureKeys: ['whereFieldGreaterThan'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
