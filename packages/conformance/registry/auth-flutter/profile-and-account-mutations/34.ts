import { row } from './section.ts';

export default row({
  order: 10,
  api: 'UserPlatform.updateProfile(profile)',
  behavior: 'Updates displayName and photoURL via bridge RPC, refreshing cached currentUser and notifying listeners.',
  featureKeys: ['updateProfile'],
  flipped: 'unit-backed',
});
