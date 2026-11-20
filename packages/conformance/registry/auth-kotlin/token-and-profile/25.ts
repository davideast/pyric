import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseUser.getIdToken(forceRefresh)',
  behavior: 'Retrieves the JWT ID token string, forcing refresh via bridge auth.getIdTokenResult when forceRefresh is true.',
  featureKeys: ['getIdToken'],
  flipped: 'live-host',
});
