import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'PyricFirebaseAppCheckPlatform.getLimitedUseToken()',
  behavior: 'Mints a ~5-minute single-use RS256 App Check JWT with a jti claim over appCheck.getLimitedUseToken without altering the cached standard token or emitting on onTokenChange.',
  featureKeys: ['getLimitedUseToken'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart`, with single-use `verifyToken(jwt, { consume: true })` replay detection verified in `packages/cli/test/serve/native-flutter-appcheck-conformance.test.ts`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
