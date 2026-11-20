import { row } from './section.ts';

export default row({
  order: 140,
  api: 'QuerySnapshot.isEmpty / count',
  behavior: 'Inspection properties reporting empty status and count of matched documents.',
  featureKeys: ['isEmpty', 'count'],
  flipped: 'unit-backed',
});
