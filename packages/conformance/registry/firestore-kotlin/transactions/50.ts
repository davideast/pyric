import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Transaction.set(documentReference, data, options)',
  behavior: 'Enqueues transactional set mutation to be committed on handler completion.',
  featureKeys: ['set', 'transaction'],
  flipped: 'unit-backed',
});
