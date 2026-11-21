import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'WriteBatch.update(documentReference, data)',
  behavior: 'Enqueues update operation into atomic mutation batch.',
  featureKeys: ['update', 'batch'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
