import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFirestore.getInstance() / Firebase.firestore',
  behavior: 'Returns the default FirebaseFirestore instance for the default FirebaseApp.',
  featureKeys: ['getInstance'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-instance-flows-inSync-and-toObject'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
