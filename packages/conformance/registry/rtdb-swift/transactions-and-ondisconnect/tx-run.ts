import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.runTransactionBlock(_:)',
  behavior: 'Executes optimistic concurrency transaction block on MutableData and commits upon success.',
  featureKeys: ['runTransactionBlock'],
});
