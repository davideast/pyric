import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 90,
  api: 'Query.whereField(_:in:)',
  behavior: 'Filters documents where field value matches any element in argument list.',
  featureKeys: ['whereFieldIn'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
