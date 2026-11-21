import { row } from './section.ts';

export default row({
  order: 30,
  api: 'HTTPSCallable.call(_:completion:) / Callable.call(_:completion:)',
  behavior: 'Executes untyped and Codable callable requests with @Sendable completion callbacks delivering (HTTPSCallableResult?, Error?) and Result<Response, Error>.',
  featureKeys: ['errorMappingCompletionAndCodableCallable'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (errorMappingCompletionAndCodableCallable).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
  ],
});
