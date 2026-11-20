import { row } from './section.ts';

export default row({
  order: 60,
  api: 'UserPlatform.isAnonymous',
  behavior: 'Reports true if user signed in anonymously, false otherwise.',
  featureKeys: ['isAnonymous'],
  flipped: 'unit-backed',
});
