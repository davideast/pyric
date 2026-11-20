import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseReference.root',
  behavior: 'Returns the root DatabaseReference from any descendant reference.',
  featureKeys: ['root'],
});
