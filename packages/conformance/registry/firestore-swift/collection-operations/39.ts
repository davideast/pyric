import { row } from './section.ts';

export default row({
  order: 50,
  api: 'CollectionReference.document(_:)',
  behavior: 'Instantiates a child DocumentReference at relative document path.',
  featureKeys: ['documentPath'],
  flipped: 'unit-backed',
});
