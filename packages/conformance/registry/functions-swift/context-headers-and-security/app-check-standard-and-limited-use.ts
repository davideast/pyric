import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HTTPSCallableOptions(requireLimitedUseAppCheckTokens:) (X-Firebase-AppCheck)',
  behavior: 'Attaches cached standard X-Firebase-AppCheck tokens when AppCheck is configured and mints distinct single-use tokens per call when requireLimitedUseAppCheckTokens is true.',
  featureKeys: ['HTTPSCallableOptions', 'requireLimitedUseAppCheckTokens'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` and `packages/cli/test/serve/native-swift-functions-conformance.test.ts` (single-use consume replay verification).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
