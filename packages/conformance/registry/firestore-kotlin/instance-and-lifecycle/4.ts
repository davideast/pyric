import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseFirestore.document(path)',
  behavior: 'Instantiates a DocumentReference pointing to the slash-delimited path.',
  featureKeys: ['document'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-instance-flows-inSync-and-toObject'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
