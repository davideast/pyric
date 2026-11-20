import { row } from './section.ts';

export default row({
  order: 40,
  api: 'WriteBatch.commit()',
  behavior: 'Atomically commits all enqueued mutations across multiple documents.',
  featureKeys: ['commit', 'batch'],
  flipped: 'unit-backed',
});
