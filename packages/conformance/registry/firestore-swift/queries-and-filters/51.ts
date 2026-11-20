import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 110,
  api: 'Query.whereFilter(_:)',
  behavior: 'Applies composite boolean Filter using andFilter or orFilter disjunctions.',
  featureKeys: ['whereFilter'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
