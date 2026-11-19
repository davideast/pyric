import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken(appId, { ttlMillis: 1800999 | 1800000.5 })',
  behavior: 'Rounds fractional `ttlMillis / 1000` for the JWT `exp - iat` claim and floors `ttlMillis` in the resolved `AppCheckToken` object.',
  notes: 'Capture key `fractionalTtl`: `1800999` gives `ttlMillis: 1800999` and `exp - iat: 1801`; `1800000.5` gives `ttlMillis: 1800000` and `exp - iat: 1800`.',
});
