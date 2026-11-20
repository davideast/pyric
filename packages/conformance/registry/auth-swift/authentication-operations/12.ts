import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'live-host',
  api: 'Auth.signOut()',
  behavior: 'Signs out the current user, clears currentUser, and notifies all state listeners.',
  featureKeys: ['signOut'],
});
