import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 140,
  api: 'Query.startAt(documentSnapshot) / endAt(documentSnapshot)',
  behavior: 'Positions query pagination cursors using DocumentSnapshot instances.',
  featureKeys: ['startAt', 'endAt'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
