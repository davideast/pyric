import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Transaction.get(documentReference)',
  behavior: 'Reads document snapshot within transaction context and acquires read lock.',
  featureKeys: ['get', 'transaction'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
