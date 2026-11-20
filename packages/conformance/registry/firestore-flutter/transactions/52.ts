import { row } from './section.ts';

export default row({
  order: 40,
  api: 'TransactionPlatform.delete(path)',
  behavior: 'Enqueues transactional delete mutation to be committed on handler completion.',
  featureKeys: ['delete', 'transaction'],
  flipped: 'unit-backed',
});
