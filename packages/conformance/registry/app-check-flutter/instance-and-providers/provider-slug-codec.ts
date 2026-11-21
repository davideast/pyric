import { row } from './section.ts';

export default row({
  order: 30,
  api: 'resolveAppCheckActivation() / normalizeProviderTypeSlug()',
  behavior: 'Resolves debugToken and siteKey metadata across AndroidDebugProvider, AppleDebugProvider, WebDebugProvider, WindowsDebugProvider, ReCaptchaV3Provider, ReCaptchaEnterpriseProvider, and legacy AndroidProvider/AppleProvider enums.',
  featureKeys: ['resolveAppCheckActivation', 'ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` (resolves canonical wire provider slugs across Android, Apple, Web, Windows, and legacy enums).',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
  ],
});
