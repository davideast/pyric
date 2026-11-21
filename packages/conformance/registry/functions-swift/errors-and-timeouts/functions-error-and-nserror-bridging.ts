import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FunctionsError / FunctionsErrorCode (0..16) / FunctionsErrorDomain / FunctionsErrorDetailsKey',
  behavior: 'Maps all 17 canonical gRPC status codes and HTTP fallback statuses into FunctionsError with NSError domain com.firebase.functions, decoded details in userInfo, and catch pattern matching.',
  featureKeys: ['FunctionsError', 'FunctionsErrorCode', 'FunctionsErrorDomain', 'FunctionsErrorDetailsKey'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (errorMappingCompletionAndCodableCallable) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
