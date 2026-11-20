import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Transaction.update(documentReference, data)',
  behavior: 'Enqueues transactional update mutation to be committed on handler completion.',
  featureKeys: ['update', 'transaction'],
  flipped: 'unit-backed',
});
