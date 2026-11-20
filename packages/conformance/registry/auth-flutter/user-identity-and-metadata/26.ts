import { row } from './section.ts';

export default row({
  order: 70,
  api: 'UserPlatform.emailVerified',
  behavior: 'Indicates whether user email address has been verified.',
  featureKeys: ['emailVerified'],
  flipped: 'unit-backed',
});
