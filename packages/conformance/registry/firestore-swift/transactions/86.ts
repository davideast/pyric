import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Transaction.setData(_:forDocument:)',
  behavior: 'Stages transactional set overwrite mutation.',
  featureKeys: ['transactionSetData'],
  flipped: 'unit-backed',
});
