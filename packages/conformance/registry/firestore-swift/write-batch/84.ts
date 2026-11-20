import { row } from './section.ts';

export default row({
  order: 60,
  api: 'WriteBatch.commit()',
  behavior: 'Atomically commits all enqueued batch mutations in a single transaction.',
  featureKeys: ['batchCommit'],
  flipped: 'unit-backed',
});
