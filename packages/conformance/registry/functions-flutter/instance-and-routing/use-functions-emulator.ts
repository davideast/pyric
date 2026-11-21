import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseFunctions.useFunctionsEmulator(host, port) / normalizeEmulatorOrigin()',
  behavior: 'Validates non-empty host and 1..65535 port bounds, brackets IPv6 addresses, normalizes 10.0.2.2 to 127.0.0.1, and routes callables to http://<host>:<port>/<projectId>/<region>/<name>.',
  featureKeys: ['useFunctionsEmulator', 'normalizeEmulatorOrigin'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart`, `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart`, and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#1).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
