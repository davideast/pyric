import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseDatabase.reference',
  behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
  featureKeys: ['reference'],
});
