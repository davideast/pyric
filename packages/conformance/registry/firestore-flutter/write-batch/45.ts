import { row } from './section.ts';

export default row({
  order: 10,
  api: 'WriteBatchPlatform.set(path, data, options)',
  behavior: 'Enqueues set or merge operation into atomic mutation batch.',
  featureKeys: ['set', 'batch'],
  flipped: 'unit-backed',
});
