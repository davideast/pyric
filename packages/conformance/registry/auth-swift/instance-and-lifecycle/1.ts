import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'unit-backed',
  api: 'Auth.auth()',
  behavior: 'Returns the default Auth instance configured with the default FirebaseApp.',
  featureKeys: ['auth'],
});
