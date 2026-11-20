import { row } from './section.ts';

export default row({
  order: 40,
  api: 'CollectionReference.document()',
  behavior: 'Instantiates a child DocumentReference with an auto-generated unique ID.',
  featureKeys: ['documentAutoId'],
  flipped: 'unit-backed',
});
