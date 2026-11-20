import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'TransactionResult.abort()',
  behavior: 'Aborts an in-progress transaction without writing changes to the database.',
  featureKeys: ['transactionAbort'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
