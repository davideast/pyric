import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentReference.path',
  behavior: 'Returns the slash-delimited path relative to the database root.',
  featureKeys: ['path'],
  flipped: 'unit-backed',
});
