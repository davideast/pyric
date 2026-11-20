import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'User.updateProfile(displayName:photoURL:)',
  behavior: 'Updates the user\'s display name and photo URL asynchronously.',
  featureKeys: ['updateProfile'],
});
