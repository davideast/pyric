import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CollectionReference.document([path])',
  behavior: 'Returns DocumentReference under collection; auto-generates 20-char ID if path omitted.',
  featureKeys: ['document'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
