import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseDatabase.getInstance() / Firebase.database',
  behavior: 'Returns the default FirebaseDatabase instance bound to the active bridge connection.',
  featureKeys: ['getInstance'],
});
