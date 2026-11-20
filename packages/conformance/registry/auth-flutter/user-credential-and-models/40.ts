import { row } from './section.ts';

export default row({
  order: 20,
  api: 'UserCredentialPlatform.additionalUserInfo',
  behavior: 'Provides AdditionalUserInfo indicating whether authenticated user is a new user.',
  featureKeys: ['additionalUserInfo'],
  flipped: 'unit-backed',
});
