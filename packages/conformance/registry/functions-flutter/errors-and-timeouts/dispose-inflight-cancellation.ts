import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFunctions.dispose() in-flight callable cancellation',
  behavior: 'Cancels in-flight HttpsCallable.call() Futures and rejects subsequent invocations on a disposed instance with FirebaseFunctionsException(code: "cancelled").',
  featureKeys: ['FirebaseFunctions.dispose'],
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` (enforces client timeout with deadline-exceeded and instance dispose with cancelled).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
  ],
});
