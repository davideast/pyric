import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HttpsCallableOptions(timeout:) / HttpsCallable.withTimeout(duration)',
  behavior: 'Defaults callable deadlines to 70 seconds, clones per-call overrides via withTimeout, and rejects slow calls with FirebaseFunctionsException(code: "deadline-exceeded").',
  featureKeys: ['HttpsCallable.withTimeout', 'defaultCallableTimeout', 'deadline-exceeded'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#2).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
