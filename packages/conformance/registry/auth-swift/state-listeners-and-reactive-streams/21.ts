import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'oracle-backed',
  api: 'Auth.authStateChanges',
  behavior: 'Exposes an AsyncSequence for modern async/await iteration over auth state transitions.',
  featureKeys: ['authStateChanges'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
