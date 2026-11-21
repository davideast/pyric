import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'Auth.removeStateDidChangeListener(_:)',
  behavior: 'Detaches an auth state change listener using its registration handle.',
  featureKeys: ['onAuthStateChanged'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
