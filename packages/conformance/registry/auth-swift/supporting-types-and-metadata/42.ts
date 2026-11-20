import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'live-host',
  api: 'AuthDataResult.user',
  behavior: 'Returns the User instance associated with the authentication result.',
  featureKeys: ['authDataResult'],
});
