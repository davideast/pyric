import { row } from './section.ts';

export default row({
  order: 80,
  api: 'DocumentSnapshot.subscript',
  behavior: 'Provides subscript syntax snapshot[key] to access document fields.',
  featureKeys: ['subscript'],
  flipped: 'unit-backed',
});
