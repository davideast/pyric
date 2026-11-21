import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'User.photoURL',
  behavior: 'Returns the user\'s profile photo URL if set.',
  featureKeys: ['photoURL'],
  oracleObservations: ['auth-swift-profile-token-claims-and-delete-lifecycle'],
});
