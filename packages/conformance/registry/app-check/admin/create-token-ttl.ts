import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'getAppCheck().createToken(appId, { ttlMillis })',
  featureKeys: ['createToken'],
  behavior: '`ttlMillis` of 30 minutes is honored in the result and in `exp - iat`; 29 minutes and 7 days plus one second reject with `app-check/invalid-argument` and the message that names the 30 minute to 7 day range.',
  evidence: 'capture `app-check-admin-create-token-custom-ttl`.',
  observations: ['app-check-admin-create-token-custom-ttl'],
  errorText: true,
});
