import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken("") / createToken(appId, { ttlMillis: 1 }) and the other local option checks',
  behavior: 'Throws synchronously on an empty `appId`, non-object `options`, and non-number or out-of-range `ttlMillis`, while rejecting asynchronously on `limitedUse` and `jti` checks.',
  notes: 'Capture key `validation` (`mode` per case: `sync-throw` vs `rejected`).',
});
