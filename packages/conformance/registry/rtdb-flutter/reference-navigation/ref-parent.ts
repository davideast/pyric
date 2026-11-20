import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseReference.parent',
  behavior: 'Returns the parent DatabaseReference, or null when called on the root reference.',
  featureKeys: ['parent'],
});
