import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFunctions.httpsCallableFromUrl(url, options:) / httpsCallableFromUri(uri, options:) & gateway routing',
  behavior: 'Rewrites project cloudfunctions.net URLs onto the local Pyric Functions HTTP gateway while refusing foreign projects and off-machine origins with FirebaseFunctionsException(code: "unavailable") before network I/O.',
  featureKeys: ['httpsCallableFromUrl', 'httpsCallableFromUri'],
  status: 'diverged-documented',
  statusNote: 'local gateway & off-machine guard',
  evidence: 'Instead of sending HTTPS requests to external Cloud Functions endpoints, `resolveUrlCallableTarget` routes same-project `cloudfunctions.net` URLs to `http(s)://<gateway>/<projectId>/<region>/<name>` and fails off-machine URLs immediately with `FirebaseFunctionsException(code: "unavailable")`. Verified in `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#1).',
  tests: [
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
