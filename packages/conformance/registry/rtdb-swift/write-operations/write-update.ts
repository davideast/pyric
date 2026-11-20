import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseReference.updateChildValues(_:)',
  behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
  featureKeys: ['updateChildValues'],
});
