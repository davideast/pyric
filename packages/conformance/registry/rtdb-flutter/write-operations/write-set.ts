import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.set(value)',
  behavior: 'Overwrites data at the reference path with the provided JSON-serializable value.',
  featureKeys: ['set'],
});
