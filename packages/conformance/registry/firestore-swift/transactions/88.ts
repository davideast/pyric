import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Transaction.setData(_:forDocument:mergeFields:)',
  behavior: 'Stages transactional selective field merge mutation.',
  featureKeys: ['transactionSetDataMergeFields'],
  flipped: 'unit-backed',
});
