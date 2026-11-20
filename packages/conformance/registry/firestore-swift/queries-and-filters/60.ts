import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 200,
  api: 'Query.getDocuments(source:)',
  behavior: 'Executes query and returns QuerySnapshot from server, cache, or default source.',
  featureKeys: ['getDocuments'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
