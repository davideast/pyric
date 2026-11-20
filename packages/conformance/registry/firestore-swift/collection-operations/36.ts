import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CollectionReference.path',
  behavior: 'Returns the full slash-separated collection path relative to database root.',
  featureKeys: ['path'],
  flipped: 'unit-backed',
});
