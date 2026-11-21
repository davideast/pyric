import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Callable<Request, Response> / callAsFunction(_:) / FirebaseDataEncoder / FirebaseDataDecoder',
  behavior: 'Encodes Swift Encodable requests and decodes Decodable responses (including Int64Value fields) across Callable.call(_:) and direct callAsFunction invocation.',
  featureKeys: ['Callable', 'callAsFunction', 'FirebaseDataEncoder', 'FirebaseDataDecoder'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (errorMappingCompletionAndCodableCallable) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
