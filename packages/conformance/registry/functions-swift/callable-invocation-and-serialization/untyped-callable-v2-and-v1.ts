import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Functions.httpsCallable(_ name:options:) / HTTPSCallable.call(_:) / HTTPSCallableResult.data',
  behavior: 'Invokes v2 onCall and v1 https.onCall endpoints via {"data": ...} JSON POST and unwraps either result or data response envelopes into HTTPSCallableResult.',
  featureKeys: ['HTTPSCallable', 'HTTPSCallableResult'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
