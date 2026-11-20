import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 130,
  api: 'Query.endAt(values) / endBefore(values)',
  behavior: 'Positions ending cursor boundary using field values.',
  featureKeys: ['endAt', 'endBefore'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
