import { row } from './section.ts';

export default row({
  order: 20,
  api: 'GetTokenResult',
  behavior: 'Encapsulates token string, custom claims, expirationTimestamp, authTimestamp, and issuedAtTimestamp.',
  featureKeys: ['getTokenResult'],
  flipped: 'live-host',
});
