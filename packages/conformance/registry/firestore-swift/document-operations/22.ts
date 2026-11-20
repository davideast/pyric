import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.documentID',
  behavior: 'Returns the document identifier representing the last path component.',
  featureKeys: ['documentID'],
  flipped: 'unit-backed',
});
