import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'AppCheckDebugProviderFactory / AppAttestProviderFactory / DeviceCheckProviderFactory',
  behavior: 'Validates non-empty googleAppID on initialization and mints locally signed RS256 App Check JWTs over appCheck.getToken and appCheck.getLimitedUseToken with provider slugs debug, app-attest, and device-check.',
  featureKeys: [
    'AppCheckDebugProviderFactory',
    'AppAttestProviderFactory',
    'DeviceCheckProviderFactory',
    'AppAttestProvider',
    'DeviceCheckProvider',
  ],
  status: 'diverged-documented',
  statusNote: 'sandbox RS256 minting',
  evidence: 'Instead of performing Apple App Attest or DeviceCheck hardware attestation against Apple and Google attestation endpoints, built-in providers request locally signed RS256 App Check JWTs (`iss: https://firebaseappcheck.googleapis.com/<projectNumber>`) from the Pyric host over `appCheck.getToken` and `appCheck.getLimitedUseToken`, verifiable by `pyric-admin/app-check` `verifyToken()`. Verified across all three providers in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` and `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
