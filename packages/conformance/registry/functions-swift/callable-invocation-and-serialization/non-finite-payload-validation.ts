import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FunctionsSerializer non-finite floating-point validation',
  behavior: 'Rejects NaN and +-Infinity Double/Float values cleanly with FunctionsErrorCode.invalidArgument before touching the HTTP transport.',
  featureKeys: ['serializerRoundTripAndValidation'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (serializerRoundTripAndValidation).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
  ],
});
