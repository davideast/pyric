import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricFirebaseAppCheckPlatform.activate(providerAndroid:, providerApple:, webProvider:, providerWindows:)',
  behavior: 'Maps FlutterFire Android, Apple, Web, Windows, and legacy enum attestation providers to canonical wire slugs, clears cached tokens when switching provider kinds, and requests locally signed RS256 JWTs from the Pyric host.',
  featureKeys: [
    'PyricFirebaseAppCheckPlatform.activate',
    'AndroidPlayIntegrityProvider',
    'AppleAppAttestProvider',
  ],
  status: 'diverged-documented',
  statusNote: 'sandbox RS256 minting',
  evidence: 'Instead of invoking native Play Integrity, Apple App Attest / DeviceCheck, or reCAPTCHA attestation SDKs, `activate(...)` resolves canonical wire provider identifiers (`debug`, `play-integrity`, `app-attest`, `device-check`, `recaptcha-v3`, `recaptcha-enterprise`) and mints locally signed RS256 App Check JWTs from the Pyric host over `appCheck.getToken` and `appCheck.getLimitedUseToken`. Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
