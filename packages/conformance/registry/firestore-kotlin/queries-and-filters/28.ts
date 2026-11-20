import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  api: 'Query.where(filter)',
  behavior: 'Evaluates composite boolean expressions constructed via Filter.and(...) or Filter.or(...).',
  featureKeys: ['where', 'filter'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
