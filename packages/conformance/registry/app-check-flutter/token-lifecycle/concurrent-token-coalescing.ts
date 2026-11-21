import { row } from './section.ts';

export default row({
  order: 30,
  api: 'PyricFirebaseAppCheckPlatform.getToken(false) (concurrent in-flight coalescing)',
  behavior: 'Coalesces concurrent getToken(false) callers onto a single in-flight appCheck.getToken bridge operation.',
  featureKeys: ['coalesces concurrent getToken'],
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` (coalesces concurrent getToken(false) requests and isolates getLimitedUseToken from standard cache).',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
  ],
});
