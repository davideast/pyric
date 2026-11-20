import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Transaction.deleteDocument(_:)',
  behavior: 'Stages transactional document deletion.',
  featureKeys: ['transactionDeleteDocument'],
  flipped: 'unit-backed',
});
