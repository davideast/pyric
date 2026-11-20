import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseDatabase.getReference(path)',
  behavior: 'Returns a DatabaseReference pointing to the specified slash-delimited path.',
  featureKeys: ['getReference'],
});
