import { row } from './section.ts';

export default row({
  order: 40,
  api: 'WriteBatchPlatform.commit()',
  behavior: 'Atomically commits all enqueued mutations across multiple documents.',
  featureKeys: ['commit', 'batch'],
  flipped: 'unit-backed',
});
