import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'unit-backed',
  api: 'AuthDataResult.user',
  behavior: 'Returns the User instance associated with the authentication result.',
  featureKeys: ['authDataResult'],
});
