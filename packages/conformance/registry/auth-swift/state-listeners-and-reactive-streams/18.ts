import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'Auth.removeIDTokenDidChangeListener(_:)',
  behavior: 'Detaches an ID token change listener using its registration handle.',
  featureKeys: ['onIdTokenChanged'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
