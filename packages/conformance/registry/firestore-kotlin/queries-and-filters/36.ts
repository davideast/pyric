import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 160,
  api: 'Query.snapshots(metadataChanges)',
  behavior: 'Returns a Coroutine Flow emitting QuerySnapshot upon matching changes.',
  featureKeys: ['snapshots'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
