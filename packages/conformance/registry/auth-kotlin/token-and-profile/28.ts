import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseUser.reload()',
  behavior: 'Reloads user profile and custom claims from bridge auth.getCurrentUser and auth.getIdTokenResult.',
  featureKeys: ['reload'],
  flipped: 'live-host',
});
