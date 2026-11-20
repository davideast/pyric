import { row } from './section.ts';

export default row({
  order: 10,
  api: 'UserProfileChangeRequest.Builder',
  behavior: 'Builds immutable UserProfileChangeRequest configuring displayName and photoUri.',
  featureKeys: ['userProfileChangeRequest'],
  flipped: 'unit-backed',
});
