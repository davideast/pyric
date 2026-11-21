import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform / FunctionsAuthTokenProvider propagation (Authorization: Bearer)',
  behavior: 'Resolves the signed-in FirebaseAuthPlatform user (or injected FunctionsAuthTokenProvider) ID token onto Authorization: Bearer <idToken> and omits the header when signed out.',
  featureKeys: ['FunctionsAuthTokenProvider', 'Authorization: Bearer'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#3).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
