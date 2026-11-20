import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'unit-backed',
  api: 'User.isAnonymous',
  behavior: 'Indicates whether the user account is anonymous.',
  featureKeys: ['isAnonymous'],
});
