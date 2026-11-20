import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseUser.photoUrl',
  behavior: 'Returns the profile photo URI or null if unset.',
  featureKeys: ['photoUrl'],
  flipped: 'live-host',
});
