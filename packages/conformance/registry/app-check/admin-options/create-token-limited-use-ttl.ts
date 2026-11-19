import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken(appId, { limitedUse: true })',
  behavior: 'When `limitedUse` is `true` and `ttlMillis` is omitted, `createToken` resolves `ttlMillis: 300000` with JWT lifetime `exp - iat` equal to `300` seconds.',
  notes: 'Capture key `limitedUse`: `ttlMillis` 300000 and `exp - iat` 300, with or without a `jti`.',
});
