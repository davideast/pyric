import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Database.reference()',
  behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
  featureKeys: ['reference'],
});
