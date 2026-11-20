import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseFirestorePlatform.doc(path)',
  behavior: 'Instantiates a DocumentReferencePlatform pointing to the slash-delimited path.',
  featureKeys: ['doc'],
  flipped: 'unit-backed',
});
