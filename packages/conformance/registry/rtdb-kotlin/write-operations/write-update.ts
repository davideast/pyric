import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseReference.updateChildren(update)',
  behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
  featureKeys: ['updateChildren'],
});
