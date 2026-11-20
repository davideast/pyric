import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Transaction.getDocument(_:)',
  behavior: 'Reads document snapshot within transaction and establishes read lock.',
  featureKeys: ['transactionGetDocument'],
  flipped: 'unit-backed',
});
