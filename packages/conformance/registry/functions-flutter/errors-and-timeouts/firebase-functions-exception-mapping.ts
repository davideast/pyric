import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctionsException / errorForCallableResponse() / codeForHttpStatus()',
  behavior: 'Maps all 17 canonical gRPC status codes and HTTP fallback statuses into FirebaseFunctionsException(plugin: "firebase_functions") with decoded details, mapping unhandled throws to "internal" and HTTP 404 to "not-found".',
  featureKeys: ['FirebaseFunctionsException', 'errorForCallableResponse', 'codeForHttpStatus'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#2).',
  tests: [
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
