import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Database.reference(withPath:)',
  behavior: 'Returns a DatabaseReference pointing to the specified slash-delimited path.',
  featureKeys: ['referenceWithPath'],
});
