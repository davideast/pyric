import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'unit-backed',
  api: 'AuthTokenResult.claims',
  behavior: 'Returns the decoded token claims dictionary.',
  featureKeys: ['authTokenResultClaims'],
});
