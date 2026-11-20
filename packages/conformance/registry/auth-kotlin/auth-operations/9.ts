import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuth.signOut()',
  behavior: 'Signs out the current user via bridge auth.signOut, clearing currentUser and resetting AuthLens to Anon.',
  featureKeys: ['signOut'],
  flipped: 'live-host',
});
