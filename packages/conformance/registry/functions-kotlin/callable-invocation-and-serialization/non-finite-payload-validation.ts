import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FunctionsSerializer non-finite floating-point and map-key validation',
  behavior: 'Fails callable Task with IllegalArgumentException when encoding non-finite Double/Float values (NaN, +-Infinity), non-String map keys, or unsupported object types.',
  featureKeys: ['IllegalArgumentException', 'Double.NaN'],
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (maps structured HttpsError details timeout and non-finite encoding errors).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
  ],
});
