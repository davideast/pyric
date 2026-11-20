import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuth.getInstance() / Firebase.auth',
  behavior: 'Returns the default FirebaseAuth instance for the default FirebaseApp.',
  featureKeys: ['getInstance'],
  flipped: 'unit-backed',
});
