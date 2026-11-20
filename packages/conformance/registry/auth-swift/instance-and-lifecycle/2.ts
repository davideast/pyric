import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'Auth.auth(app:)',
  behavior: 'Returns an Auth instance associated with the specified FirebaseApp.',
  featureKeys: ['authApp'],
});
