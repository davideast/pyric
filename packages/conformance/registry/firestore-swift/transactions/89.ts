import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Transaction.updateData(_:forDocument:)',
  behavior: 'Stages transactional update mutation for existing document.',
  featureKeys: ['transactionUpdateData'],
  flipped: 'unit-backed',
});
