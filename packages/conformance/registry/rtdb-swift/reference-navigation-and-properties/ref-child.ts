import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.child(_:)',
  behavior: 'Returns a child DatabaseReference relative to the current path.',
  featureKeys: ['child'],
});
