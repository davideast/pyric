import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'live-host',
  api: 'User.getIDTokenResult(forcingRefresh:)',
  behavior: 'Retrieves detailed AuthTokenResult with expiration and claims asynchronously.',
  featureKeys: ['getIdTokenResult'],
});
