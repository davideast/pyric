import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'unit-backed',
  api: 'AuthTokenResult.token',
  behavior: 'Returns the JWT token string.',
  featureKeys: ['authTokenResultToken'],
});
