import { row } from './section.ts';

export default row({
  order: 20,
  api: 'mapToAppCheckFirebaseException() / normalizeAppCheckErrorCode() / decodeWireAppCheckToken()',
  behavior: 'Strips appCheck/ and app-check/ wire error prefixes into FirebaseException(plugin: "firebase_app_check"), rejects malformed bridge token payloads with code "invalid-response", and guards disposed delegates with code "disposed".',
  featureKeys: ['normalizeAppCheckErrorCode', 'decodeWireAppCheckToken', 'mapToAppCheckFirebaseException'],
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` (normalizes appCheck error prefixes and rejects malformed responses; schedules proactive refresh when auto-refresh is enabled and wraps bridge errors as FirebaseException).',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
  ],
});
