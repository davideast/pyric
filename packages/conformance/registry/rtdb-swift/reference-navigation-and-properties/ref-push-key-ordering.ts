import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DatabaseReference.childByAutoId().key',
  behavior: 'Monotonically orders generated push keys lexicographically by creation timestamp.',
  featureKeys: ['pushKeyOrdering'],
});
