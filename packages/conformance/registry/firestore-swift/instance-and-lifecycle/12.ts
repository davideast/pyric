import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 120,
  api: 'Firestore.runTransaction(options:block:)',
  behavior: 'Executes an interactive transaction with custom TransactionOptions.',
  featureKeys: ['runTransactionWithOptions'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
