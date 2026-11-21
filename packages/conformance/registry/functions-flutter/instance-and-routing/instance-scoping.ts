import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseFunctions.instance / instanceFor(app:, region:) / registerWith()',
  behavior: 'Caches FirebaseFunctions singletons per (FirebaseApp, region), parses HTTP(S) region arguments into customDomain, and wires shared Pyric bridge, Auth, and App Check delegates.',
  featureKeys: ['FirebaseFunctions.instance', 'FirebaseFunctions.instanceFor', 'PyricFirebaseFunctions'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart`, `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart`, and `packages/flutter-client/test/live_host/functions_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
