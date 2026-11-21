import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctions.httpsCallable(name, options:) / HttpsCallable.call<T>([parameters]) / HttpsCallableResult<T>',
  behavior: 'Invokes v2 onCall and v1 https.onCall endpoints via {"data": ...} JSON POST (supporting both callable.call() and direct callable(params) syntax) and unwraps result or data response envelopes.',
  featureKeys: ['FirebaseFunctions.httpsCallable', 'HttpsCallable', 'HttpsCallableResult'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#1).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
