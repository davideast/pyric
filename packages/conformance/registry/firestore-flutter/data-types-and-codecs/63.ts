import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Nested Map and List collections',
  behavior: 'Deeply encodes and revives recursive nested Maps and Lists containing mixed primitives and sentinels.',
  featureKeys: ['data'],
  flipped: 'unit-backed',
});
