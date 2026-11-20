import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseUser.phoneNumber',
  behavior: 'Returns the phone number string associated with the user profile, or null if unset.',
  featureKeys: ['phoneNumber'],
  flipped: 'unit-backed',
});
