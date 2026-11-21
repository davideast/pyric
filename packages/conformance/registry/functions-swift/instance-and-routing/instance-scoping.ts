import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Functions.functions() / functions(app:region:customDomain:) / Functions.reset()',
  behavior: 'Caches Functions singletons keyed by (app.name, region, customDomain), evicts stale instances when a same-named FirebaseApp is recreated, and clears cached instances on Functions.reset().',
  featureKeys: ['Functions.functions', 'Functions.reset'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (instanceCachingAndEmulatorNormalization) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
