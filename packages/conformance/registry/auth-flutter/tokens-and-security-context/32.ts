import { row } from './section.ts';

export default row({
  order: 30,
  api: 'UserPlatform.customClaims',
  behavior: 'Exposes decoded custom claims map attached to user token identity.',
  featureKeys: ['customClaims'],
  flipped: 'unit-backed',
});
