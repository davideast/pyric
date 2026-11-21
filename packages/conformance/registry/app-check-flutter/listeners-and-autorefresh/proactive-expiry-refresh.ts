import { row } from './section.ts';

export default row({
  order: 30,
  api: 'PyricFirebaseAppCheckPlatform proactive expiry-buffer timer',
  behavior: 'Schedules Timer renewal 5 minutes before expireTimeMillis when isTokenAutoRefreshEnabled is true and emits the renewed token on onTokenChange.',
  featureKeys: ['schedules proactive refresh'],
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` (schedules proactive refresh when auto-refresh is enabled and wraps bridge errors as FirebaseException).',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
  ],
});
