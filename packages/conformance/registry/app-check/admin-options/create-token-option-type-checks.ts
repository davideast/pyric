import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['createToken'],
  api: 'getAppCheck().createToken(appId, { jti }) / ({ limitedUse: "yes" }) / ({ limitedUse: true, jti: 5 })',
  behavior: 'Rejects asynchronously with `app-check/invalid-argument` when `jti` is set without `limitedUse: true`, when `limitedUse` is not a boolean, or when `jti` is not a string.',
  notes: 'Capture keys `validation.jtiWithoutLimitedUse`, `validation.limitedUseString`, `validation.jtiNumber`: each rejects with `app-check/invalid-argument` and `` `jti` cannot be specified without setting `limitedUse` to `true`. ``, `` `limitedUse` must be a boolean value. ``, `` `jti` must be a string value. ``.',
});
