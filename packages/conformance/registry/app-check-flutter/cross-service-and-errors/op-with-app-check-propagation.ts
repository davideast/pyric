import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

const AI_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-flutter-ai-conformance.test.ts';
const FUNCTIONS_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-flutter-functions-conformance.test.ts';

export default row({
  order: 10,
  api: 'PyricFirebaseAppCheckPlatform.opWithAppCheck(method, params, limitedUse:) & cross-service propagation',
  behavior: 'Attaches a cached standard or freshly minted limited-use appCheckToken onto outgoing bridge and callable requests across Firebase AI and Cloud Functions.',
  featureKeys: ['opWithAppCheck'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart`, `packages/flutter-client/test/live_host/app_check_live_host_test.dart`, `packages/flutter-client/test/live_host/ai_live_host_test.dart`, and `packages/flutter-client/test/live_host/functions_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    'packages/flutter-client/test/live_host/ai_live_host_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
  ],
  hostConformanceTests: [
    LIVE_HOST_CONFORMANCE_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
  ],
});
