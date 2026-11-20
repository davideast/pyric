import { row } from './section.ts';

export default row({
  order: 10,
  api: 'AuthResult / AdditionalUserInfo',
  behavior: 'AuthResult packages authenticated FirebaseUser and AdditionalUserInfo (providerId, isNewUser).',
  featureKeys: ['authResult', 'additionalUserInfo'],
  flipped: 'live-host',
});
