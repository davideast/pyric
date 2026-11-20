import { row } from './section.ts';

export default row({
  order: 30,
  api: 'PyricDatabase.ref()',
  behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
  featureKeys: ['ref'],
});
