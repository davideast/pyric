import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'PyricFirebaseAppCheckPlatform.useAppCheckEmulator(host, port)',
  behavior: 'Validates host and port bounds, disconnects any previously owned bridge client, clears cached tokens, and connects PyricBridgeClient to ws://<host>:<port>/__pyric/sandbox.',
  featureKeys: ['useAppCheckEmulator'],
  status: 'diverged-documented',
  statusNote: 'bridge transport',
  evidence: 'Upstream FlutterFire `firebase_app_check` does not expose a standalone App Check emulator transport; `PyricFirebaseAppCheckPlatform.useAppCheckEmulator(host, port)` binds the delegate `PyricBridgeClient` directly to `ws://<host>:<port>/__pyric/sandbox` and rejects empty hosts or out-of-range ports with `FirebaseException(code: "invalid-argument")`. Verified live in `packages/flutter-client/test/live_host/app_check_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
