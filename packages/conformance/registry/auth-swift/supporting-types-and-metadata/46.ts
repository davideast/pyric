import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'AuthTokenResult.expirationTime',
  behavior: 'Returns the expiration timestamp of the ID token.',
  featureKeys: ['authTokenResultExpiration'],
});
