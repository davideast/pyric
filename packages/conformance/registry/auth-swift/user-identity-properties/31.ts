import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'live-host',
  api: 'User.isEmailVerified',
  behavior: 'Indicates whether the user\'s primary email address has been verified.',
  featureKeys: ['isEmailVerified'],
});
