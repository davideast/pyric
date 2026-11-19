import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken(appId, null | "str" | [] | { ttlMillis: null })',
  behavior: 'Throws synchronously with `app-check/invalid-argument` when `options` is `null`, a primitive, or an array, or when `options.ttlMillis` is `null`.',
  notes: 'Capture keys `validation.optionsNull`, `optionsString`, `optionsArray` (`AppCheckTokenOptions must be a non-null object.`) and `validation.ttlNull` (`ttlMillis must be a duration in milliseconds.`), all `app-check/invalid-argument`.',
});
