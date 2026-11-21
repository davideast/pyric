import { row } from './section.ts';

export default row({
  order: 110,
  flipped: 'oracle-backed',
  api: 'User.claims',
  behavior: 'Returns the dictionary of custom and standard claims associated with the user\'s ID token.',
  featureKeys: ['claims'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
  ],
});
