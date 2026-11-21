import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HTTPSCallable.stream(_:) mid-stream HttpsError termination',
  behavior: 'Terminates the AsyncThrowingStream with a mapped FunctionsError preserving code, message, and details after yielding earlier .message chunks when a mid-stream error frame arrives.',
  featureKeys: ['parseSSEPayloadLine'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
