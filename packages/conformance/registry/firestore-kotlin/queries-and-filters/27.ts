import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'Query.whereNotIn(field, values)',
  behavior: 'Filters documents where field value matches no element in values list (NOT IN query).',
  featureKeys: ['whereNotIn'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
