import { row } from './section.ts';

export default row({
  order: 60,
  api: 'FirebaseUser.isAnonymous',
  behavior: 'Returns true if the user account is authenticated anonymously, false otherwise.',
  featureKeys: ['isAnonymous'],
  flipped: 'unit-backed',
});
