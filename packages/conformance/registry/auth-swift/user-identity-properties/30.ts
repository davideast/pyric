import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'live-host',
  api: 'User.isAnonymous',
  behavior: 'Indicates whether the user account is anonymous.',
  featureKeys: ['isAnonymous'],
});
