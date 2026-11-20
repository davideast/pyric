import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 160,
  api: 'Query.start(at:) / start(after:)',
  behavior: 'Positions starting cursor using ordered field values.',
  featureKeys: ['startAt', 'startAfter'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
