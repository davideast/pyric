import { row } from './section.ts';

export default row({
  order: 40,
  api: 'UserPlatform.photoURL',
  behavior: 'Returns profile photo URL string or null if unset.',
  featureKeys: ['photoURL'],
  flipped: 'unit-backed',
});
