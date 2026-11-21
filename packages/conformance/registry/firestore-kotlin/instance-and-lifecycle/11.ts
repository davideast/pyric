import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 110,
  api: 'FirebaseFirestore.terminate()',
  behavior: 'Terminates the Firestore client, closing network connections and unsubscribing active snapshot flows.',
  featureKeys: ['terminate'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
