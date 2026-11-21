import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DatabaseReference.push().key',
  behavior: 'Monotonically orders generated push keys lexicographically by creation timestamp.',
  featureKeys: ['pushKeyOrdering'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-navigation-push-priorities-and-snapshots'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
