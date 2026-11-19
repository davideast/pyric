import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken(appId, { ttlMillis: NaN | "1800000" })',
  behavior: 'Throws synchronously with `app-check/invalid-argument` and message `ttlMillis must be a duration in milliseconds.` when `ttlMillis` is `NaN` or not a number.',
  notes: 'Capture keys `validation.ttlNaN`, `validation.ttlString`.',
});
