import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HttpsCallableOptions(limitedUseAppCheckToken:) (X-Firebase-AppCheck)',
  behavior: 'Attaches cached standard X-Firebase-AppCheck tokens when PyricFirebaseAppCheckPlatform is activated and mints single-use tokens per call when limitedUseAppCheckToken is true.',
  featureKeys: ['HttpsCallableOptions', 'limitedUseAppCheckToken', 'FunctionsAppCheckTokenProvider'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#3).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
