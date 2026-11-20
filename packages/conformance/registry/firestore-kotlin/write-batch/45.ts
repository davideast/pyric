import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'WriteBatch.set(documentReference, data, options)',
  behavior: 'Enqueues set or merge operation into atomic mutation batch.',
  featureKeys: ['set', 'batch'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
