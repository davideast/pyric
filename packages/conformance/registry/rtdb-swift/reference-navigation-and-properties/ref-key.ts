import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.key',
  behavior: 'Returns the last path segment token of the reference, or nil for the root reference.',
  featureKeys: ['key'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: ['rtdb-swift-navigation-push-priorities-and-snapshots'],
});
