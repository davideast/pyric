import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseDatabase.reference',
  behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
  featureKeys: ['reference'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-navigation-push-priorities-and-snapshots'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
