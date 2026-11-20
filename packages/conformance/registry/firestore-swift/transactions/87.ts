import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Transaction.setData(_:forDocument:merge:)',
  behavior: 'Stages transactional set merge mutation.',
  featureKeys: ['transactionSetDataMerge'],
  flipped: 'unit-backed',
});
