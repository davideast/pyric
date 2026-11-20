import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.remove()',
  behavior: 'Removes the node and all descendant data at the reference path.',
  featureKeys: ['remove'],
});
