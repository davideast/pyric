import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Transaction.get(documentReference)',
  behavior: 'Reads document snapshot within transaction context and acquires read lock.',
  featureKeys: ['get', 'transaction'],
  flipped: 'unit-backed',
});
