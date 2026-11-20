import { row } from './section.ts';

export default row({
  order: 10,
  api: '@DocumentID',
  behavior: 'Property wrapper populating document ID on decoding; omitted from write payloads.',
  featureKeys: ['documentIDPropertyWrapper'],
  flipped: 'unit-backed',
});
