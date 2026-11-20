import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.runTransactionBlock(_:)',
  behavior: 'Executes optimistic concurrency transaction block on MutableData and commits upon success.',
  featureKeys: ['runTransactionBlock'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
