import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.key',
  behavior: 'Returns the last path segment token of the reference, or null for the root reference.',
  featureKeys: ['key'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-navigation-push-priorities-and-snapshots'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
