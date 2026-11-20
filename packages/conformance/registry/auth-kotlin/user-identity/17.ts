import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseUser.displayName',
  behavior: 'Returns the display name associated with the user profile, or null if unset.',
  featureKeys: ['displayName'],
  flipped: 'unit-backed',
});
