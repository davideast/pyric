import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.setValue(value)',
  behavior: 'Overwrites data at the reference path with the provided value.',
  featureKeys: ['setValue'],
});
