import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FunctionsUrlResolver Cloud Run (*.a.run.app / *.run.app) URL rewriting',
  behavior: 'Rewrites legacy *.a.run.app and regional *.run.app callable URLs onto the local gateway with ?__pyric_run_service=1 service resolution.',
  featureKeys: ['__pyric_run_service'],
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (getInstance KTX caching customDomain URL rewriting and off-machine refusal).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
  ],
});
