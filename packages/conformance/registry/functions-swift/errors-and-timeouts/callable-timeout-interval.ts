import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HTTPSCallable.timeoutInterval / Callable.timeoutInterval',
  behavior: 'Defaults callable request deadlines to 70.0 seconds and throws FunctionsErrorCode.deadlineExceeded when a callable exceeds timeoutInterval.',
  featureKeys: ['timeoutInterval', 'defaultTimeoutInterval'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
