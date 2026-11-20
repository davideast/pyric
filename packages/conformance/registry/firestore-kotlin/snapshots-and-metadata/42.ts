import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_SNAPSHOTS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentSnapshot.toObject<T>()',
  behavior: 'Deserializes snapshot into typed data object via reified extension function.',
  featureKeys: ['toObject'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
