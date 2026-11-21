import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DebugAppCheckProviderFactory.getInstance() / PlayIntegrityAppCheckProviderFactory.getInstance()',
  behavior: 'Mints locally signed RS256 App Check JWTs from the Pyric host over appCheck.getToken and appCheck.getLimitedUseToken with provider slugs debug and play-integrity.',
  featureKeys: ['DebugAppCheckProviderFactory', 'PlayIntegrityAppCheckProviderFactory'],
  status: 'diverged-documented',
  statusNote: 'sandbox RS256 minting',
  evidence: 'Instead of performing Google Play Integrity hardware attestation or exchanging debug secrets with Google Firebase App Check REST endpoints, built-in factories request locally signed RS256 App Check JWTs (`iss: https://firebaseappcheck.googleapis.com/<projectNumber>`) from the Pyric host over `appCheck.getToken` and `appCheck.getLimitedUseToken`, verifiable by `pyric-admin/app-check` `verifyToken()`. Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
