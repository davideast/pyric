import { row } from './section.ts';

export default row({
  order: 30,
  api: 'TransactionPlatform.update(path, data)',
  behavior: 'Enqueues transactional update mutation to be committed on handler completion.',
  featureKeys: ['update', 'transaction'],
  flipped: 'unit-backed',
});
