import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Functions.useEmulator(withHost:port:) / emulatorOrigin',
  behavior: 'Points the Functions instance at http://<host>:<port>, brackets IPv6 addresses, normalizes the 10.0.2.2 loopback alias to 127.0.0.1, and exposes emulatorOrigin.',
  featureKeys: ['Functions.useEmulator', 'emulatorOrigin'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (instanceCachingAndEmulatorNormalization) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
